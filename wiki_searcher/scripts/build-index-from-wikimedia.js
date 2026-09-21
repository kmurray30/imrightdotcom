#!/usr/bin/env node
/**
 * One-time (or re-run-to-resume) full build: downloads a Wikimedia Enterprise
 * Snapshot and builds the pgvector paragraph-embedding index from it — end to
 * end, chunk by chunk, never holding more than a few chunks' worth of raw
 * data on disk at once. This is the script to run to bootstrap the index from
 * nothing; despite the old name, it was never just a download step.
 *
 * Earlier versions of this script downloaded and extracted the entire
 * corpus first, then expected a separate run of build-index-from-ndjson.js
 * over one combined file. That doesn't work here: English Wikipedia's
 * snapshot is over a terabyte uncompressed (Wikimedia's own docs: "Some
 * projects (like English Wikipedia) are larger than a terabyte"), and there
 * was never a good reason to materialize all of that on disk — only a
 * small, citation-filtered slice of it ever gets embedded (see
 * embeddingIndex.js). So each chunk now goes through its whole lifecycle
 * before the next one starts: download -> extract -> embed every article's
 * citation-adjacent paragraphs -> delete the chunk's archive and extracted
 * copy. Peak extra disk usage is a few chunks' worth of raw data (a few GB
 * at EMBED_CONCURRENCY chunks in flight), not the whole corpus.
 *
 * Downloads by CHUNK, not as one giant file — this is what the Snapshot API
 * docs recommend for a project this large, and it's what makes concurrency
 * possible at all: chunks are independently downloadable objects. Auth is
 * fully automatic via utils/wikimediaAuth.js: just set WIKIMEDIA_USERNAME and
 * WIKIMEDIA_PASSWORD and this script logs in on its own, no separate
 * wikimedia-login.js step required. That script only exists for people who'd
 * rather not keep their password in an env var long-term — run it once to
 * mint a WIKIMEDIA_REFRESH_TOKEN, set that instead, and remove the password.
 *
 * Resumable at three levels, cheapest check first:
 *   - A chunk with a .done marker is fully processed (downloaded, extracted,
 *     embedded, cleaned up) — skipped entirely.
 *   - A chunk with an extracted .ndjson already on disk (downloaded and
 *     extracted, but not yet embedded when a prior run stopped) skips
 *     straight to embedding instead of re-downloading.
 *   - Otherwise downloadOne resumes the partial archive by its own
 *     byte-range logic, same as before.
 *   - Below all of that, every individual article is independently
 *     resumable too (embeddingIndex.js skips one whose version_identifier
 *     hasn't changed) — so even re-processing an already-done chunk is
 *     cheap, this just avoids the wasted re-download/re-extract on top.
 *
 * Concurrency: CONCURRENCY (6) governs the network-only sizing pass, well
 * under Wikimedia Enterprise's free-tier 10 QPS limit. EMBED_CONCURRENCY (4)
 * governs the full per-chunk pipeline once embedding (CPU-bound, and each
 * chunk holds a Postgres connection while it runs) is in the mix — kept
 * below the connection pool's max (imright/scripts/db.js, max: 5) so chunks
 * don't end up waiting on each other for a connection.
 *
 * Honest caveats, unverified live from this environment (Wikimedia's
 * domains are blocked here): that Node's fetch strips Authorization but
 * forwards Range across the redirect to each chunk's presigned URL, the
 * same way curl does per the docs; and that each chunk's archive extracts
 * to exactly one top-level .ndjson file with no further nesting.
 *
 * Usage: node wiki_searcher/scripts/build-index-from-wikimedia.js [identifier] [destDir]
 *   identifier - defaults to enwiki_namespace_0
 *   destDir    - defaults to ./wiki-snapshots
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadEnv } from '../../imright/load-env.js';
import { getAccessToken } from '../../utils/wikimediaAuth.js';
import { callExternalApi, HttpStatusError, timeoutSignal } from '../../utils/external-api.js';
import { upsertArticleEmbeddings } from '../embeddingIndex.js';

loadEnv();
const execFileAsync = promisify(execFile);

const API_BASE = 'https://api.enterprise.wikimedia.com';
const identifier = process.argv[2] || 'enwiki_namespace_0';
const destDir = process.argv[3] || './wiki-snapshots';
const CONCURRENCY = 6; // sizing pass only — pure network, raise if you're on a paid plan with a higher QPS limit
const EMBED_CONCURRENCY = 4; // full download+extract+embed pipeline — keep at/below the DB pool's max (5)
const METADATA_TIMEOUT_MS = 15_000; // HEAD/info calls should be fast; don't hang forever if one stalls
const STALL_TIMEOUT_MS = 30_000; // abort a chunk download if no bytes arrive for this long

const PROGRESS_BAR_WIDTH = 30;
const PROGRESS_RENDER_INTERVAL_MS = 200;
const SPEED_WINDOW_MS = 5000; // recent-window speed, more responsive than a lifetime average on a multi-hour download

function formatGB(bytes) {
  return (bytes / 1e9).toFixed(2);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Tracks aggregate download progress across all in-flight chunks and renders one combined status line. */
function createProgressTracker(totalBytes) {
  let downloadedBytes = 0;
  const samples = []; // { time, bytes } — pruned to the last SPEED_WINDOW_MS
  let lastRenderAt = 0;

  function render() {
    const now = Date.now();
    samples.push({ time: now, bytes: downloadedBytes });
    while (samples.length > 1 && now - samples[0].time > SPEED_WINDOW_MS) samples.shift();

    const oldest = samples[0];
    const elapsedSec = (now - oldest.time) / 1000;
    const speedBps = elapsedSec > 0 ? (downloadedBytes - oldest.bytes) / elapsedSec : 0;
    const remainingBytes = totalBytes - downloadedBytes;
    const etaSeconds = speedBps > 0 ? remainingBytes / speedBps : NaN;

    const fraction = totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 0;
    const filled = Math.round(fraction * PROGRESS_BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
    const pct = (fraction * 100).toFixed(1).padStart(5, ' ');

    process.stdout.write(
      `\r[${bar}] ${pct}%  ${formatGB(downloadedBytes)} / ${formatGB(totalBytes)} GB` +
        `  ${(speedBps / 1e6).toFixed(2)} MB/s  ETA ${formatDuration(etaSeconds)}   `
    );
  }

  return {
    addBytes(n) {
      downloadedBytes += n;
      const now = Date.now();
      if (now - lastRenderAt >= PROGRESS_RENDER_INTERVAL_MS) {
        render();
        lastRenderAt = now;
      }
    },
    finish() {
      render();
      process.stdout.write('\n');
    },
  };
}

function throwForBadResponse(response, message) {
  const retryAfterHeader = response.headers.get('retry-after');
  throw new HttpStatusError(response.status, message, {
    retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : undefined,
  });
}

/** Wraps a metadata call (HEAD/info) in the project's standard retry-with-backoff, so a 429 slows down and retries instead of killing the run. */
function withRetry(operation, fn, maxRetries = 4) {
  return callExternalApi({ service: 'wikimedia_enterprise', operation, pipelineStep: 'wiki_snapshot_download', fn, maxRetries });
}

async function fetchJson(url, accessToken, method = 'GET') {
  return withRetry('snapshot_info', async () => {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: timeoutSignal(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throwForBadResponse(response, `${method} ${url} failed: ${response.status} ${response.statusText}`);
    return response.json();
  });
}

async function headDownload(url, accessToken) {
  return withRetry('snapshot_head', async () => {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: timeoutSignal(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throwForBadResponse(response, `HEAD ${url} failed: ${response.status} ${response.statusText}`);
    return {
      contentLength: Number(response.headers.get('content-length')),
      etag: response.headers.get('etag'),
      acceptsRanges: response.headers.get('accept-ranges') === 'bytes',
    };
  });
}

/**
 * Downloads one chunk's archive resumably, reporting newly-streamed bytes to
 * `tracker` (pre-existing on-disk bytes are credited by the caller before
 * this runs). `metadata` ({ contentLength, etag, acceptsRanges }) comes from
 * the sizing pass — deliberately not re-HEAD-ing here, since every chunk
 * was already HEAD'd once for its total size.
 */
async function downloadOne(url, filePath, accessToken, tracker, metadata) {
  const { contentLength, etag, acceptsRanges } = metadata;
  const etagSidecarPath = `${filePath}.etag`;

  // This is the ONE place that decides how many on-disk bytes for this
  // chunk are trustworthy — and therefore the one place that's allowed to
  // credit them to the tracker. Crediting a chunk's raw on-disk size
  // anywhere else, before this function gets a chance to reset it
  // (oversized/rotated-ETag cases), causes double-counting.
  let startByte = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (startByte === contentLength) {
    // Trust an exact size match immediately, with no dependency on the ETag
    // sidecar — a completed chunk has its sidecar deleted on success, so
    // checking the ETag first would make every completed chunk look
    // "rotated" (no sidecar to compare against) on a later run.
    tracker.addBytes(startByte);
    return;
  } else if (startByte > contentLength) {
    // Oversized/corrupted — can't be trusted at any size. Reset and re-download.
    fs.rmSync(filePath, { force: true });
    startByte = 0;
  } else if (startByte > 0) {
    // Genuinely partial — only safe to resume if the snapshot hasn't
    // rotated underneath us since whatever wrote these bytes.
    const previousEtag = fs.existsSync(etagSidecarPath) ? fs.readFileSync(etagSidecarPath, 'utf8').trim() : null;
    if (previousEtag !== etag) {
      fs.rmSync(filePath, { force: true });
      startByte = 0;
    }
  }
  tracker.addBytes(startByte); // whatever we're keeping/resuming from, credited exactly once, right here
  fs.writeFileSync(etagSidecarPath, etag ?? '');

  const headers = { Authorization: `Bearer ${accessToken}` };
  const isResuming = startByte > 0 && acceptsRanges;
  if (isResuming) headers.Range = `bytes=${startByte}-`;

  let alreadyComplete = false;
  await withRetry('snapshot_chunk_download', async () => {
    // Re-check on every retry attempt — a prior attempt may have written
    // some bytes before failing, so this needs to reflect what's on disk
    // right now, not what it was when downloadOne started.
    const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const attemptHeaders = { ...headers };
    if (currentSize > 0 && acceptsRanges) attemptHeaders.Range = `bytes=${currentSize}-`;

    // Guards against a silent hang mid-transfer too, not just on connect:
    // the timer resets on every chunk received, so it only fires if bytes
    // stop arriving for STALL_TIMEOUT_MS, not because the transfer is slow.
    const controller = new AbortController();
    let stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
    };

    let writeStream;
    let bytesThisAttempt = 0;
    try {
      const response = await fetch(url, { headers: attemptHeaders, signal: controller.signal });
      if (response.status === 416) {
        alreadyComplete = true;
        return;
      }
      if (!response.ok && response.status !== 206) {
        throwForBadResponse(response, `Download failed: ${response.status} ${response.statusText}`);
      }

      writeStream = fs.createWriteStream(filePath, { flags: currentSize > 0 ? 'a' : 'w' });
      for await (const chunk of Readable.fromWeb(response.body)) {
        resetStallTimer();
        // Hard stop the moment this chunk would exceed its known size —
        // checked before counting it anywhere, so bytesThisAttempt always
        // matches exactly what was added to the tracker (needed for a
        // clean rollback below).
        if (Number.isFinite(contentLength) && contentLength > 0 && currentSize + bytesThisAttempt + chunk.length > contentLength) {
          throw new Error(
            `${path.basename(filePath)} received more bytes than its reported size ` +
              `(${currentSize + bytesThisAttempt + chunk.length} > ${contentLength}) — aborting this attempt.`
          );
        }
        bytesThisAttempt += chunk.length;
        tracker.addBytes(chunk.length);
        if (!writeStream.write(chunk)) {
          await new Promise((resolve) => writeStream.once('drain', resolve));
        }
      }
      await new Promise((resolve, reject) => writeStream.end((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      // Undo this attempt's byte count and any bytes it wrote before
      // failing — a retried attempt otherwise resumes from a file size
      // that doesn't reflect the failed attempt's still-draining writes,
      // both end up writing the same region, and every byte gets
      // double-counted.
      tracker.addBytes(-bytesThisAttempt);
      if (writeStream && !writeStream.destroyed) {
        await new Promise((resolve) => writeStream.destroy(undefined, () => resolve()));
      }
      try {
        if (fs.existsSync(filePath)) fs.truncateSync(filePath, currentSize);
      } catch {
        // best-effort; the next attempt's own currentSize re-read is the real safety net
      }

      if (error.name === 'AbortError') {
        throw new Error(`Chunk stalled — no data received for ${STALL_TIMEOUT_MS / 1000}s (${path.basename(filePath)}).`);
      }
      throw error;
    } finally {
      clearTimeout(stallTimer);
    }
  });

  if (alreadyComplete) return;

  const finalSize = fs.statSync(filePath).size;
  if (Number.isFinite(contentLength) && contentLength > 0 && finalSize !== contentLength) {
    throw new Error(`Size mismatch for ${path.basename(filePath)}: expected ${contentLength}, got ${finalSize}.`);
  }
  fs.rmSync(etagSidecarPath, { force: true });
}

async function runWithConcurrency(items, worker, concurrency) {
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      await worker(items[cursor++]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runNext));
}

/** Extracts one chunk's archive, deletes the archive, and returns the extracted NDJSON path. */
async function extractChunk(chunk) {
  const archiveName = path.basename(chunk.filePath);
  await execFileAsync('tar', ['xzf', archiveName], { cwd: destDir });
  fs.rmSync(chunk.filePath, { force: true }); // compressed copy no longer needed once extracted

  const extractedPath = path.join(destDir, `${chunk.chunkId}.ndjson`);
  if (!fs.existsSync(extractedPath)) {
    throw new Error(`Expected ${extractedPath} after extracting ${archiveName}, but it's not there — check what tar actually produced.`);
  }
  return extractedPath;
}

/** Streams one chunk's NDJSON, embeds every article's citation-adjacent paragraphs, then deletes the raw extracted file. */
async function embedChunkArticles(ndjsonPath) {
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  const stats = { articles: 0, paragraphs: 0, alreadyCurrent: 0 };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let article;
    try {
      article = JSON.parse(line);
    } catch {
      continue; // skip malformed lines rather than aborting the whole chunk
    }
    const wikitext = article.article_body?.wikitext;
    if (!wikitext) continue; // deleted/visibility-changed/empty articles omit article_body

    const result = await upsertArticleEmbeddings({
      title: article.name,
      wikitext,
      versionIdentifier: article.version?.identifier,
      pageId: article.identifier,
    });
    stats.articles++;
    stats.paragraphs += result.paragraphCount;
    if (result.skipped) stats.alreadyCurrent++;
  }

  fs.rmSync(ndjsonPath, { force: true }); // already embedded — don't keep the raw extracted copy around
  return stats;
}

/** Runs one chunk through its whole lifecycle: download -> extract -> embed -> cleanup -> mark done. */
async function processChunk(chunk, accessToken, tracker, totals) {
  const donePath = path.join(destDir, `${chunk.chunkId}.done`);
  if (fs.existsSync(donePath)) {
    tracker.addBytes(chunk.contentLength); // already fully processed in a prior run
    return;
  }

  const alreadyExtractedPath = path.join(destDir, `${chunk.chunkId}.ndjson`);
  let ndjsonPath;
  if (fs.existsSync(alreadyExtractedPath)) {
    // Downloaded and extracted in a prior run, but not yet embedded when
    // that run stopped — pick up from here instead of re-downloading.
    tracker.addBytes(chunk.contentLength);
    ndjsonPath = alreadyExtractedPath;
  } else {
    await downloadOne(chunk.url, chunk.filePath, accessToken, tracker, {
      contentLength: chunk.contentLength,
      etag: chunk.etag,
      acceptsRanges: chunk.acceptsRanges,
    });
    ndjsonPath = await extractChunk(chunk);
  }

  const stats = await embedChunkArticles(ndjsonPath);
  totals.chunksDone++;
  totals.articles += stats.articles;
  totals.paragraphs += stats.paragraphs;
  totals.alreadyCurrent += stats.alreadyCurrent;

  fs.writeFileSync(donePath, new Date().toISOString());
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });
  const accessToken = await getAccessToken();

  console.log(`Looking up chunks for ${identifier}...`);
  const info = await fetchJson(`${API_BASE}/v2/snapshots/${identifier}`, accessToken, 'POST');
  const chunkIds = info.chunks ?? [];
  if (chunkIds.length === 0) {
    throw new Error(`No chunks found for ${identifier} — double-check the identifier.`);
  }

  const chunks = chunkIds.map((chunkId) => ({
    chunkId,
    url: `${API_BASE}/v2/snapshots/${identifier}/chunks/${chunkId}/download`,
    filePath: path.join(destDir, `${chunkId}.tar.gz`),
  }));

  console.log(`${chunks.length} chunks, ${info.record_count ?? '?'} articles total. Checking sizes (concurrency ${CONCURRENCY})...`);
  let totalBytes = 0;
  let checked = 0;
  await runWithConcurrency(
    chunks,
    async (chunk) => {
      const { contentLength, etag, acceptsRanges } = await headDownload(chunk.url, accessToken);
      chunk.contentLength = contentLength;
      chunk.etag = etag;
      chunk.acceptsRanges = acceptsRanges;
      totalBytes += contentLength;
      checked++;
      if (checked % 25 === 0 || checked === chunks.length) {
        process.stdout.write(`\r  ...checked ${checked}/${chunks.length} chunks`);
      }
    },
    CONCURRENCY
  );
  process.stdout.write('\n');
  console.log(
    `Total: ${formatGB(totalBytes)} GB across ${chunks.length} chunks. Downloading, extracting, and embedding ` +
      `${EMBED_CONCURRENCY} chunks at a time (never holding more than a few chunks' worth of raw data on disk)...`
  );

  const tracker = createProgressTracker(totalBytes);
  const totals = { chunksDone: 0, articles: 0, paragraphs: 0, alreadyCurrent: 0 };

  await runWithConcurrency(chunks, (chunk) => processChunk(chunk, accessToken, tracker, totals), EMBED_CONCURRENCY);
  tracker.finish();

  console.log(
    `\nDone. ${chunks.length} chunks total (${totals.chunksDone} newly processed this run): ` +
      `${totals.articles} articles seen, ${totals.paragraphs} paragraphs embedded, ${totals.alreadyCurrent} already current.`
  );
  console.log('The vector index is up to date — no separate build step needed.');
}

main().catch((error) => {
  console.error('\nFatal error:', error.message);
  console.error('Re-run this script to resume — completed chunks (marked .done) are skipped, others pick up where they left off.');
  process.exit(1);
});
