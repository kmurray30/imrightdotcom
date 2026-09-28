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
 * The chunk list and sizing pass (identifier lookup + a HEAD per chunk) are
 * cached to destDir/snapshot-metadata.json after the first run, since that
 * data only changes when Wikimedia rotates the snapshot (monthly on the free
 * tier) — every resume was otherwise repeating the exact same 436 HEAD
 * requests, which is also what kept tripping the rate limit before a run
 * even got to downloading anything. Delete that file to force a fresh
 * lookup (e.g. if you suspect the snapshot rotated).
 *
 * Concurrency: CONCURRENCY (6) governs the network-only sizing pass, well
 * under Wikimedia Enterprise's free-tier 10 QPS limit. EMBED_CONCURRENCY (4)
 * governs the full per-chunk pipeline once embedding (CPU-bound, and each
 * chunk holds a Postgres connection while it runs) is in the mix — kept
 * below the connection pool's max (imright/scripts/db.js, max: 5) so chunks
 * don't end up waiting on each other for a connection.
 *
 * Honest caveat, unverified live from this environment (Wikimedia's domains
 * are blocked here): that Node's fetch strips Authorization but forwards
 * Range across the redirect to each chunk's presigned URL, the same way curl
 * does per the docs. (The other original caveat here — that each archive
 * extracts to a predictably-named top-level .ndjson file — turned out to be
 * false in practice; extractChunk now lists the archive's actual contents
 * with `tar tzf` instead of assuming a name, and normalizes whatever it
 * finds to the canonical destDir/${chunkId}.ndjson path.)
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
import { setLogger as setEmbedLogger } from '../textEmbeddings.js';

loadEnv();
const execFileAsync = promisify(execFile);
// Keeps the terminal to just the aggregate progress bar — the one-time
// embedding-model-download detail (see textEmbeddings.js) goes to debug.log
// instead, same as every other per-chunk stage transition below.
setEmbedLogger(logDebug);

const API_BASE = 'https://api.enterprise.wikimedia.com';
const identifier = process.argv[2] || 'enwiki_namespace_0';
const destDir = process.argv[3] || './wiki-snapshots';
const CONCURRENCY = 6; // sizing pass only — pure network, raise if you're on a paid plan with a higher QPS limit
const EMBED_CONCURRENCY = 4; // full download+extract+embed pipeline — keep at/below the DB pool's max (5)
const METADATA_TIMEOUT_MS = 15_000; // HEAD/info calls should be fast; don't hang forever if one stalls
const STALL_TIMEOUT_MS = 30_000; // abort a chunk download if no bytes arrive for this long

const PROGRESS_BAR_WIDTH = 20; // kept narrow — the numeric fields (count/rate/ETA) matter more than the bar itself on a one-line, width-constrained status display
const PROGRESS_RENDER_INTERVAL_MS = 200;
const SPEED_WINDOW_MS = 5000; // recent-window speed, more responsive than a lifetime average on a multi-hour download

function formatGB(bytes) {
  return (bytes / 1e9).toFixed(2);
}

/** Compact "902.1K" / "7.33M" style formatting — a raw comma-grouped 7,332,159 is needlessly wide for a one-line status display. */
function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

/** "3d14h" / "23h5m" / "5m32s" / "45s" — the two largest non-zero units only, not every unit down to seconds. */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const totalSeconds = Math.floor(seconds);
  const units = [
    { label: 'd', value: Math.floor(totalSeconds / 86400) },
    { label: 'h', value: Math.floor((totalSeconds % 86400) / 3600) },
    { label: 'm', value: Math.floor((totalSeconds % 3600) / 60) },
    { label: 's', value: totalSeconds % 60 },
  ];
  const firstNonZero = units.findIndex((u) => u.value > 0);
  if (firstNonZero === -1) return '0s';
  return units
    .slice(firstNonZero, firstNonZero + 2)
    .map((u) => `${u.value}${u.label}`)
    .join('');
}

/**
 * Truncates to the terminal's actual width and clears any leftover
 * characters from a previous, longer render. Without this, a line that
 * exceeds the terminal width wraps onto a second row, and "\r" then only
 * returns to the start of THAT wrapped row rather than the true beginning
 * of the logical line — which is what turns a one-line progress display
 * into what looks like a new line being printed on every tick, each one
 * cut off mid-word. process.stdout.columns is undefined when stdout isn't
 * a TTY (e.g. piped to a file), in which case there's no wrapping concern.
 */
function fitToTerminal(line) {
  const width = process.stdout.columns;
  const fitted = width && line.length > width - 1 ? line.slice(0, width - 1) : line;
  return `\r${fitted}\x1b[K`; // \x1b[K: clear from cursor to end of line
}

/** A single rolling-window counter: total so far, plus a recent-window rate for ETA purposes. */
function createCounter() {
  let done = 0;
  const samples = []; // { time, done } — pruned to the last SPEED_WINDOW_MS
  return {
    add(n) {
      done += n;
    },
    stats() {
      const now = Date.now();
      samples.push({ time: now, done });
      while (samples.length > 1 && now - samples[0].time > SPEED_WINDOW_MS) samples.shift();
      const oldest = samples[0];
      const elapsedSec = (now - oldest.time) / 1000;
      const rate = elapsedSec > 0 ? (done - oldest.done) / elapsedSec : 0;
      return { done, rate };
    },
  };
}

/**
 * Renders one combined status line, driven by ARTICLES EMBEDDED as the
 * primary metric (bar/%/ETA), with bytes downloaded shown as secondary
 * context. Articles, not bytes, are what actually track overall completion
 * here: downloading is the fast part, and once the first EMBED_CONCURRENCY
 * chunks finish downloading, the byte counter can sit still for a long time
 * — sequential local CPU embedding of thousands of articles per chunk is
 * the real bottleneck — while real work keeps happening in the background.
 * A byte-only bar (the original design) looks stalled for exactly that
 * reason even when everything's fine.
 *
 * Runs its own render interval rather than piggybacking on addArticles/
 * addBytes calls, so the printed line updates at a steady cadence
 * regardless of how bursty either counter's actual updates are.
 */
function createProgressDisplay(totalArticles) {
  const articles = createCounter();
  const bytes = createCounter();
  let intervalId = null;

  function render() {
    const { done: articlesDone, rate: articleRate } = articles.stats();
    const { done: bytesDone } = bytes.stats();

    if (totalArticles > 0) {
      const remaining = totalArticles - articlesDone;
      const etaSeconds = articleRate > 0 ? remaining / articleRate : NaN;
      const fraction = Math.min(1, articlesDone / totalArticles);
      const filled = Math.round(fraction * PROGRESS_BAR_WIDTH);
      const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
      const pct = (fraction * 100).toFixed(1).padStart(5, ' ');
      // Kept deliberately compact (short labels, K/M-suffixed counts) and
      // still run through fitToTerminal — see the header printed once at
      // startup (main()) for what each field means, since a one-line format
      // this dense isn't self-explanatory the first time you see it.
      process.stdout.write(
        fitToTerminal(
          `[${bar}] ${pct}%  ${formatCount(articlesDone)}/${formatCount(totalArticles)} art` +
            `  ${articleRate.toFixed(1)} art/s  ETA ${formatDuration(etaSeconds)}  ${formatGB(bytesDone)}GB dl`
        )
      );
    } else {
      // No article-count denominator to compute a % or ETA against — fall back to raw counts.
      process.stdout.write(fitToTerminal(`${formatCount(articlesDone)} articles processed, ${formatGB(bytesDone)}GB downloaded`));
    }
  }

  return {
    addArticles(n) {
      articles.add(n);
    },
    addBytes(n) {
      bytes.add(n);
    },
    start() {
      intervalId = setInterval(render, PROGRESS_RENDER_INTERVAL_MS);
      intervalId.unref(); // don't let this timer alone keep the process alive if something else goes wrong before finish() runs
    },
    finish() {
      if (intervalId) clearInterval(intervalId);
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

/**
 * Extracts one chunk's archive, deletes the archive, and returns the
 * extracted NDJSON path — always at destDir/${chunkId}.ndjson, regardless of
 * whatever name/layout the archive itself actually uses internally (proven
 * necessary in practice: the archive does NOT extract to a file named after
 * the chunk id, contrary to what was originally assumed here). Lists the
 * archive's contents first rather than guessing, extracts, then normalizes
 * whatever came out to the canonical path so every downstream check
 * (processChunk's resumability tiers, embedChunkArticles, cleanup) can keep
 * assuming that fixed layout without caring what tar actually produced.
 */
async function extractChunk(chunk) {
  const archiveName = path.basename(chunk.filePath);
  const canonicalPath = path.join(destDir, `${chunk.chunkId}.ndjson`);

  const { stdout } = await execFileAsync('tar', ['tzf', archiveName], { cwd: destDir, maxBuffer: 10 * 1024 * 1024 });
  const entries = stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, '')) // tar lists relative entries with a leading "./" — strip it so path math below is sane
    .filter(Boolean);
  const ndjsonEntry = entries.find((entry) => entry.endsWith('.ndjson'));
  if (!ndjsonEntry) {
    throw new Error(`No .ndjson entry found inside ${archiveName} — archive contains: ${entries.join(', ') || '(nothing)'}`);
  }

  await execFileAsync('tar', ['xzf', archiveName], { cwd: destDir });
  fs.rmSync(chunk.filePath, { force: true }); // compressed copy no longer needed once extracted

  const actualPath = path.join(destDir, ndjsonEntry);
  if (!fs.existsSync(actualPath)) {
    throw new Error(`tar listed ${ndjsonEntry} inside ${archiveName}, but it's not on disk after extracting — check what tar actually produced.`);
  }
  if (actualPath !== canonicalPath) {
    fs.renameSync(actualPath, canonicalPath);
    // Clean up whatever subdirectory the archive extracted into, now that
    // its one file of interest has been moved out of it. Only when the
    // (now "./"-stripped) entry actually names a subdirectory — an entry
    // with no "/" at all (a flat archive) has no extraction directory of
    // its own to remove, and treating an empty split segment as "the top
    // dir" here would resolve to destDir itself, deleting every other
    // chunk's data alongside it.
    if (ndjsonEntry.includes('/')) {
      const entryTopDir = ndjsonEntry.split('/')[0];
      fs.rmSync(path.join(destDir, entryTopDir), { recursive: true, force: true });
    }
  }
  return canonicalPath;
}

/**
 * Appends a timestamped line to destDir/debug.log — the answer to "why is
 * this stuck" for a multi-hour, multi-chunk-concurrent run where the single
 * aggregate progress bar can't tell you which of the EMBED_CONCURRENCY
 * chunks (if any) has stalled, or at which stage. `tail -f` this file
 * instead of guessing from the outside (lsof, ps, etc.) next time something
 * looks hung. fs.appendFileSync is safe to call from multiple concurrent
 * async tasks here — this is one process with one event loop, not multiple
 * OS processes racing to write, so there's no interleaving/corruption risk.
 */
function logDebug(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(path.join(destDir, 'debug.log'), line);
}

/**
 * Streams one chunk's NDJSON, embeds every article's citation-adjacent
 * paragraphs, then deletes the raw extracted file. Local CPU embedding of
 * every paragraph, fully sequential (one article at a time, no internal
 * concurrency here), is genuinely slow for a chunk with thousands of
 * qualifying articles — logging on a fixed article-count threshold (the
 * original approach) meant a chunk with fewer articles than that threshold
 * produced zero visible progress for however long the whole thing took,
 * indistinguishable from a real hang. Logging on a time interval instead
 * (plus immediately on the very first article) adapts to that regardless of
 * chunk size or speed.
 */
async function embedChunkArticles(chunkId, ndjsonPath, tracker) {
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  const stats = { articles: 0, paragraphs: 0, alreadyCurrent: 0 };
  let lastLoggedAt = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    // Counted here, before the parse/wikitext checks below, so the live
    // article tracker's numerator converges with recordCount (the total
    // record count across the whole corpus, used as its denominator)
    // regardless of how many records get skipped for lacking wikitext —
    // those are still "done" from a progress-percentage standpoint, just
    // not embeddable.
    tracker.addArticles(1);

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

    const now = Date.now();
    if (stats.articles === 1 || now - lastLoggedAt >= 10_000) {
      logDebug(`${chunkId}: embedding in progress — ${stats.articles} articles, ${stats.paragraphs} paragraphs so far`);
      lastLoggedAt = now;
    }
  }

  fs.rmSync(ndjsonPath, { force: true }); // already embedded — don't keep the raw extracted copy around
  return stats;
}

/**
 * Runs one chunk through its whole lifecycle: download -> extract -> embed
 * -> cleanup -> mark done. avgArticlesPerChunk credits an *estimate* to the
 * live article tracker for a chunk that's already fully .done from a prior
 * run — its actual per-article counting happened in that earlier process
 * (and isn't persisted anywhere finer-grained than the .done marker itself),
 * so without this a resumed run's progress display would understate true
 * completion by however many chunks were already finished before it started.
 */
async function processChunk(chunk, accessToken, tracker, totals, avgArticlesPerChunk) {
  const donePath = path.join(destDir, `${chunk.chunkId}.done`);
  if (fs.existsSync(donePath)) {
    tracker.addBytes(chunk.contentLength); // already fully processed in a prior run
    tracker.addArticles(avgArticlesPerChunk);
    return;
  }

  const alreadyExtractedPath = path.join(destDir, `${chunk.chunkId}.ndjson`);
  let ndjsonPath;
  if (fs.existsSync(alreadyExtractedPath)) {
    // Downloaded and extracted in a prior run, but not yet embedded when
    // that run stopped — pick up from here instead of re-downloading.
    logDebug(`${chunk.chunkId}: resuming from already-extracted .ndjson, skipping straight to embedding`);
    tracker.addBytes(chunk.contentLength);
    ndjsonPath = alreadyExtractedPath;
  } else {
    logDebug(`${chunk.chunkId}: starting download`);
    await downloadOne(chunk.url, chunk.filePath, accessToken, tracker, {
      contentLength: chunk.contentLength,
      etag: chunk.etag,
      acceptsRanges: chunk.acceptsRanges,
    });
    logDebug(`${chunk.chunkId}: download complete, extracting`);
    ndjsonPath = await extractChunk(chunk);
    logDebug(`${chunk.chunkId}: extraction complete, starting embed`);
  }

  const stats = await embedChunkArticles(chunk.chunkId, ndjsonPath, tracker);
  totals.chunksDone++;
  totals.articles += stats.articles;
  totals.paragraphs += stats.paragraphs;
  totals.alreadyCurrent += stats.alreadyCurrent;

  logDebug(`${chunk.chunkId}: done — ${stats.articles} articles, ${stats.paragraphs} paragraphs, ${stats.alreadyCurrent} already current`);
  fs.writeFileSync(donePath, new Date().toISOString());
}

/**
 * The chunk list and each chunk's {contentLength, etag, acceptsRanges} only
 * change when Wikimedia rotates this identifier's snapshot (monthly on the
 * free tier) — re-fetching them on every run/resume was 1 + 436 requests for
 * data that's almost always identical to last time, and the sole reason the
 * sizing pass kept tripping the free tier's rate limit. Cached here, keyed by
 * identifier; delete the file (or change the identifier) to force a refresh.
 * If the snapshot did rotate underneath a stale cache, downloadOne's own
 * final size check still catches it (throws on a mismatch) rather than
 * silently writing wrong data — this is a speed optimization, not a
 * correctness dependency.
 */
function loadCachedSnapshotMetadata() {
  const cachePath = path.join(destDir, 'snapshot-metadata.json');
  if (!fs.existsSync(cachePath)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.identifier !== identifier || !Array.isArray(cached.chunks)) return null;
    return cached;
  } catch {
    return null; // corrupt/partial cache file — treat as absent, re-fetch
  }
}

function saveSnapshotMetadata(recordCount, chunks) {
  const cachePath = path.join(destDir, 'snapshot-metadata.json');
  fs.writeFileSync(cachePath, JSON.stringify({ identifier, recordCount, chunks }, null, 2));
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });
  const accessToken = await getAccessToken();

  let chunks;
  let recordCount;
  const cached = loadCachedSnapshotMetadata();
  if (cached) {
    chunks = cached.chunks;
    recordCount = cached.recordCount;
    console.log(
      `Using cached chunk list from a previous run (${chunks.length} chunks, ${recordCount ?? '?'} articles) — ` +
        `delete wiki-snapshots/snapshot-metadata.json to force a fresh lookup.`
    );
  } else {
    console.log(`Looking up chunks for ${identifier}...`);
    const info = await fetchJson(`${API_BASE}/v2/snapshots/${identifier}`, accessToken, 'POST');
    const chunkIds = info.chunks ?? [];
    if (chunkIds.length === 0) {
      throw new Error(`No chunks found for ${identifier} — double-check the identifier.`);
    }
    recordCount = info.record_count;

    chunks = chunkIds.map((chunkId) => ({
      chunkId,
      url: `${API_BASE}/v2/snapshots/${identifier}/chunks/${chunkId}/download`,
      filePath: path.join(destDir, `${chunkId}.tar.gz`),
    }));

    console.log(`${chunks.length} chunks, ${recordCount ?? '?'} articles total. Checking sizes (concurrency ${CONCURRENCY})...`);
    let checked = 0;
    await runWithConcurrency(
      chunks,
      async (chunk) => {
        const { contentLength, etag, acceptsRanges } = await headDownload(chunk.url, accessToken);
        chunk.contentLength = contentLength;
        chunk.etag = etag;
        chunk.acceptsRanges = acceptsRanges;
        checked++;
        if (checked % 25 === 0 || checked === chunks.length) {
          process.stdout.write(`\r  ...checked ${checked}/${chunks.length} chunks`);
        }
      },
      CONCURRENCY
    );
    process.stdout.write('\n');
    saveSnapshotMetadata(recordCount, chunks);
  }

  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.contentLength, 0);
  console.log(
    `Total: ${formatGB(totalBytes)} GB across ${chunks.length} chunks. Downloading, extracting, and embedding ` +
      `${EMBED_CONCURRENCY} chunks at a time (never holding more than a few chunks' worth of raw data on disk)...`
  );
  console.log(
    `Per-chunk stage progress is logged to wiki-snapshots/debug.log — if the progress bar below stalls, ` +
      `run "tail -f wiki-snapshots/debug.log" in another terminal to see exactly which chunk and stage it's stuck on.`
  );
  logDebug(`=== run started: ${chunks.length} chunks, ${formatGB(totalBytes)} GB total ===`);
  console.log(
    'Progress line below: [bar] % done   articles done/total   embedding rate   ETA   total downloaded so far'
  );

  const tracker = createProgressDisplay(recordCount);
  const avgArticlesPerChunk = recordCount > 0 ? recordCount / chunks.length : 0;
  const totals = { chunksDone: 0, articles: 0, paragraphs: 0, alreadyCurrent: 0 };

  tracker.start();
  await runWithConcurrency(
    chunks,
    (chunk) => processChunk(chunk, accessToken, tracker, totals, avgArticlesPerChunk),
    EMBED_CONCURRENCY
  );
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
  try {
    logDebug(`=== fatal error: ${error.message} ===`);
  } catch {
    // best-effort — don't let a logging failure hide the real error above
  }
  process.exit(1);
});
