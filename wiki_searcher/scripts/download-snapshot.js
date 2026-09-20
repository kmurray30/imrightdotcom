#!/usr/bin/env node
/**
 * Downloads (resumably, concurrently) and extracts a Wikimedia Enterprise
 * Snapshot — the raw text+structure corpus that build-index-from-snapshot.js
 * consumes.
 *
 * Downloads by CHUNK, not as one giant file — this is what the Snapshot API
 * docs recommend for a project as large as English Wikipedia, and it's also
 * what makes concurrency possible at all: chunks are independently
 * downloadable objects, so several can be fetched in parallel instead of
 * fighting over a single HTTP connection. Auth is fully automatic via
 * utils/wikimediaAuth.js — nothing to copy-paste.
 *
 * Each chunk resumes independently (its own partial file + ETag sidecar),
 * so an interrupted run only has to redo whichever chunks weren't finished.
 *
 * Concurrency default (6) stays well under Wikimedia Enterprise's free-tier
 * 10 QPS limit — each chunk only issues a HEAD + a GET to start, then
 * streams, so 6 concurrent chunks is nowhere near that ceiling.
 *
 * Honest caveat on whether this actually speeds things up: if your own
 * connection is the bottleneck, splitting one slow pipe into more streams
 * won't create bandwidth that isn't there. It's most likely to help if the
 * backend is rate-limiting individual connections, which is common for the
 * presigned cloud-storage URLs this API redirects to — worth just trying.
 *
 * NOTE: as before, this leans on Node's fetch stripping Authorization but
 * forwarding Range across the redirect to each chunk's presigned URL, the
 * same way curl does per the docs — not verified live from this environment.
 * Also unverified: that each chunk's archive extracts to a plain .ndjson
 * file with no further nesting — if extraction produces something else,
 * the combine step below will just find zero .ndjson files and say so.
 *
 * Usage: node wiki_searcher/scripts/download-snapshot.js [identifier] [destDir]
 *   identifier - defaults to enwiki_namespace_0
 *   destDir    - defaults to ./wiki-snapshots
 */
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadEnv } from '../../imright/load-env.js';
import { getAccessToken } from '../../utils/wikimediaAuth.js';
import { callExternalApi, HttpStatusError, timeoutSignal } from '../../utils/external-api.js';

loadEnv();
const execFileAsync = promisify(execFile);

const API_BASE = 'https://api.enterprise.wikimedia.com';
const identifier = process.argv[2] || 'enwiki_namespace_0';
const destDir = process.argv[3] || './wiki-snapshots';
const CONCURRENCY = 6; // raise if you're on a paid plan with a higher QPS limit
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

/** Tracks aggregate progress across all concurrently-downloading chunks and renders one combined status line. */
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
 * Downloads one chunk resumably, reporting newly-streamed bytes to `tracker`
 * (pre-existing bytes are credited by the caller before this runs).
 * `metadata` ({ contentLength, etag, acceptsRanges }) comes from the sizing
 * pass in downloadAllChunks — deliberately not re-HEAD-ing here, since
 * every chunk was already HEAD'd once for its total size; doing it again
 * per chunk doubled the request volume for no reason and was a real
 * contributor to hitting the rate limit.
 */
async function downloadOne(url, filePath, accessToken, tracker, metadata) {
  const { contentLength, etag, acceptsRanges } = metadata;
  const etagSidecarPath = `${filePath}.etag`;

  // This is the ONE place that decides how many on-disk bytes for this
  // chunk are trustworthy — and therefore the one place that's allowed to
  // credit them to the tracker. A separate pre-pass in downloadAllChunks
  // used to credit a chunk's raw on-disk size before this function got a
  // chance to reset it (oversized/rotated-ETag cases), so every reset chunk
  // got counted once there AND again in full as it re-downloaded here.
  // Deciding and crediting in the same place makes that impossible.
  let startByte = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (startByte === contentLength) {
    // Trust an exact size match immediately, with no dependency on the ETag
    // sidecar. A completed chunk has its sidecar deleted on success (see the
    // cleanup at the end of this function) — checking the ETag first here,
    // like an earlier version of this did, meant a completed chunk with no
    // sidecar always looked "rotated" and got needlessly deleted and
    // re-downloaded from scratch on every subsequent run.
    tracker.addBytes(startByte);
    return;
  } else if (startByte > contentLength) {
    // Oversized — e.g. corrupted by the double-counting bug this version
    // fixes. Reset and re-download; can't be trusted at any size, exact
    // match or not.
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
    // some bytes before failing, so isResuming/startByte-equivalent state
    // needs to reflect what's on disk right now, not what it was initially.
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
        // Hard stop the moment this chunk would exceed its known size — a
        // defense against any cause of overrun (not just the retry race
        // fixed below), so a bad transfer errors out immediately instead of
        // silently growing past the total forever. Checked before counting
        // this chunk anywhere, so bytesThisAttempt always matches exactly
        // what was added to the tracker (needed for a clean rollback below).
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
      // Undo this attempt's byte count and any bytes it wrote before failing
      // — without this, a retried attempt resumes from a file size that
      // doesn't yet reflect the failed attempt's still-draining writes, both
      // end up writing the same region, and every byte gets double-counted
      // (this is exactly the "downloaded exceeds total" bug this fixes).
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

async function downloadAllChunks(accessToken) {
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
  console.log(`Total: ${formatGB(totalBytes)} GB across ${chunks.length} chunks. Downloading with concurrency ${CONCURRENCY}...`);

  const tracker = createProgressTracker(totalBytes);
  // Bytes already on disk get credited inside downloadOne itself, not here —
  // it's the only place that knows whether an existing file is trustworthy
  // (exact size match) or needs resetting (oversized/rotated ETag). Crediting
  // it separately here caused every reset chunk to be counted twice: once
  // for its stale on-disk size, again in full as it re-downloaded.

  await runWithConcurrency(
    chunks,
    (chunk) =>
      downloadOne(chunk.url, chunk.filePath, accessToken, tracker, {
        contentLength: chunk.contentLength,
        etag: chunk.etag,
        acceptsRanges: chunk.acceptsRanges,
      }),
    CONCURRENCY
  );
  tracker.finish();

  return chunks.map((c) => c.filePath);
}

async function extractAndCombine(archivePaths) {
  console.log('Extracting chunks...');
  for (const archivePath of archivePaths) {
    await execFileAsync('tar', ['xzf', path.basename(archivePath)], { cwd: destDir });
  }

  const extractedFiles = fs.readdirSync(destDir).filter((f) => f.endsWith('.ndjson'));
  if (extractedFiles.length === 0) {
    throw new Error(`No .ndjson files found in ${destDir} after extraction — check what tar actually produced there.`);
  }

  const combinedPath = path.join(destDir, `${identifier}.combined.ndjson`);
  console.log(`Combining ${extractedFiles.length} extracted files into ${combinedPath}...`);
  const writeStream = fs.createWriteStream(combinedPath);
  for (const file of extractedFiles) {
    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(path.join(destDir, file));
      readStream.on('error', reject);
      readStream.pipe(writeStream, { end: false });
      readStream.on('end', resolve);
    });
  }
  await new Promise((resolve, reject) => writeStream.end((error) => (error ? reject(error) : resolve())));
  return combinedPath;
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });
  const accessToken = await getAccessToken();

  const archivePaths = await downloadAllChunks(accessToken);
  const combinedPath = await extractAndCombine(archivePaths);

  console.log(`\nDone. Combined NDJSON: ${combinedPath}`);
  console.log(`Next: node wiki_searcher/scripts/build-index-from-snapshot.js ${combinedPath}`);
}

main().catch((error) => {
  console.error('\nFatal error:', error.message);
  console.error('Re-run this script to resume — completed/partial chunk files are left in place.');
  process.exit(1);
});
