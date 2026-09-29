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
import { upsertArticleEmbeddings, setConnectionWarningLogger } from '../embeddingIndex.js';
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
const EMBED_CONCURRENCY = 4; // chunks in flight at once — bounds peak disk usage (raw archive + extracted NDJSON per chunk), not DB load
// Articles processed concurrently WITHIN each chunk. upsertArticleEmbeddings
// spends most of its wall-clock time waiting on DB round-trips over a
// tunnel to a remote Postgres, not on local CPU — processing them one at a
// time (the original design) left that wait time completely unoverlapped.
// Combined with EMBED_CONCURRENCY, this is EMBED_CONCURRENCY * this many
// simultaneous DB connections, so DB_POOL_MAX below is sized to match.
const ARTICLE_CONCURRENCY = 8;
process.env.DB_POOL_MAX ??= String(EMBED_CONCURRENCY * ARTICLE_CONCURRENCY + 2); // +2 headroom for other occasional queries (refresh-daily.js, etc. sharing the same Postgres); only takes effect if the user hasn't already set this themselves
const METADATA_TIMEOUT_MS = 15_000; // HEAD/info calls should be fast; don't hang forever if one stalls
const STALL_TIMEOUT_MS = 30_000; // abort a chunk download if no bytes arrive for this long

const PROGRESS_BAR_WIDTH = 30; // fitToTerminal() truncates safely on a narrow terminal, so there's no need to keep this cramped for width's sake
const PROGRESS_RENDER_INTERVAL_MS = 200;
// Long enough to span several ARTICLE_CONCURRENCY batch-flush cycles (so
// Art/s doesn't swing between "a batch just landed" and "nothing yet," the
// problem with the old 5s window), short enough to actually reflect a real
// slowdown/speedup well before the whole-run average (ETA's basis) would.
const RECENT_RATE_WINDOW_MS = 20_000;

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

function padLeft(text, width) {
  return text.length >= width ? text.slice(0, width) : ' '.repeat(width - text.length) + text;
}
function padRight(text, width) {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}
function center(text, width) {
  if (text.length >= width) return text.slice(0, width);
  const pad = width - text.length;
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + text + ' '.repeat(pad - left);
}

function tableBorder(widths) {
  return '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
}

/** aligns: one of 'left'/'right'/'center' per column, defaulting to 'right' (numeric data reads naturally right-aligned in a table). */
function tableRow(cells, widths, aligns = []) {
  return (
    '|' +
    cells
      .map((cell, i) => {
        const width = widths[i];
        const align = aligns[i] ?? 'right';
        const padded = align === 'center' ? center(cell, width) : align === 'left' ? padRight(cell, width) : padLeft(cell, width);
        return ` ${padded} `;
      })
      .join('|') +
    '|'
  );
}

/**
 * A single counter reporting TWO different rates from the same underlying
 * progress, deliberately biased differently:
 *
 *  - `rate`: this RUN's lifetime average (total real progress / total
 *    elapsed time since the counter was created, effectively since the run
 *    started) — what ETA is computed from. Stable on purpose: an ETA that
 *    jumps around every tick is worse than useless, and a multi-hour/day job
 *    shouldn't have its time-remaining estimate whipsawed by a few seconds
 *    of variance.
 *  - `recentRate`: a rolling window (RECENT_RATE_WINDOW_MS) over the same
 *    real progress — what the Art/s column shows. More reactive than `rate`
 *    on purpose: it's the "what's happening right now" number, and should
 *    move if the run genuinely speeds up or slows down, well before that
 *    shows up in a whole-run average.
 *
 * Both exclude burst credits (see addBurst) from their numerator — a
 * resumed chunk's checkpoint or an already-.done chunk from a PRIOR process
 * reflects work this run never spent any time on, so crediting it toward
 * either rate would overstate real throughput, not just briefly (the old 5s
 * window's problem) but for as long as that credit stays inside whichever
 * window is looking at it.
 */
function createCounter() {
  let done = 0;
  let realDone = 0; // like `done`, but excludes burst credits — only this counts toward either rate
  const startTime = Date.now();
  const recentSamples = []; // { time, realDone } — pruned to RECENT_RATE_WINDOW_MS, feeds recentRate only
  return {
    add(n) {
      done += n;
      realDone += n;
    },
    /**
     * Credits `n` toward the total WITHOUT it counting toward either rate —
     * see the class-level comment above for why.
     */
    addBurst(n) {
      done += n;
    },
    get done() {
      return done; // raw cumulative total, including burst credits — for callers that just want the number, not a rate
    },
    stats() {
      const now = Date.now();

      const lifetimeElapsedSec = (now - startTime) / 1000;
      const rate = lifetimeElapsedSec > 0 ? realDone / lifetimeElapsedSec : 0;

      recentSamples.push({ time: now, realDone });
      while (recentSamples.length > 1 && now - recentSamples[0].time > RECENT_RATE_WINDOW_MS) recentSamples.shift();
      const oldest = recentSamples[0];
      const recentElapsedSec = (now - oldest.time) / 1000;
      const recentRate = recentElapsedSec > 0 ? (realDone - oldest.realDone) / recentElapsedSec : rate;

      return { done, rate, recentRate };
    },
  };
}

/**
 * Renders one combined status TABLE (fixed-width bordered columns, a header
 * printed once, and a single data row updated in place), driven by ARTICLES
 * EMBEDDED as the primary metric (bar/%/ETA), with bytes downloaded shown as
 * a secondary column. Articles, not bytes, are what actually track overall
 * completion here: downloading is the fast part, and once the first
 * EMBED_CONCURRENCY chunks finish downloading, the byte counter can sit
 * still for a long time — sequential local CPU embedding of thousands of
 * articles per chunk is the real bottleneck — while real work keeps
 * happening in the background. A byte-only bar looks stalled for exactly
 * that reason even when everything's fine.
 *
 * Column widths are computed once up front from the known totals (so
 * "articles done" never needs more room than "articles total" already
 * reserves) and never change after that — this is what keeps the columns
 * from jittering in width as the numbers grow, and keeps the header cells
 * aligned with the data cells below them.
 *
 * Runs its own render interval rather than piggybacking on addArticles/
 * addBytes calls, so the printed row updates at a steady cadence regardless
 * of how bursty either counter's actual updates are.
 */
function createProgressDisplay(totalArticles, totalBytes) {
  const articles = createCounter();
  const bytes = createCounter();
  let intervalId = null;

  const headers = ['Progress', 'Done%', 'Articles', 'Art/s', 'ETA', 'Downloaded'];
  const widths = [
    Math.max(headers[0].length, PROGRESS_BAR_WIDTH + 2), // "[" + bar + "]"
    Math.max(headers[1].length, 6), // "100.0%"
    Math.max(headers[2].length, formatCount(totalArticles).length * 2 + 1), // "done/total", sized to the known total on both sides
    Math.max(headers[3].length, 7), // rate, e.g. "9999.9"
    Math.max(headers[4].length, 8), // "999d23h"-ish worst case
    Math.max(headers[5].length, formatGB(totalBytes).length + 2), // formatted GB + "GB" suffix
  ];
  const aligns = ['left', 'right', 'right', 'right', 'right', 'right'];

  function render() {
    // rate (lifetime average) drives the ETA; recentRate (short rolling
    // window) drives the displayed Art/s — see createCounter's comment for
    // why these are deliberately different numbers.
    const { done: articlesDone, rate: lifetimeRate, recentRate: articleRate } = articles.stats();
    const { done: bytesDone } = bytes.stats();

    let cells;
    if (totalArticles > 0) {
      const remaining = totalArticles - articlesDone;
      const etaSeconds = lifetimeRate > 0 ? remaining / lifetimeRate : NaN;
      const fraction = Math.min(1, articlesDone / totalArticles);
      const filled = Math.round(fraction * PROGRESS_BAR_WIDTH);
      const bar = '[' + '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled) + ']';
      cells = [
        bar,
        `${(fraction * 100).toFixed(1)}%`,
        `${formatCount(articlesDone)}/${formatCount(totalArticles)}`,
        articleRate.toFixed(1),
        formatDuration(etaSeconds),
        `${formatGB(bytesDone)}GB`,
      ];
    } else {
      // No article-count denominator to compute a % or ETA against — fall back to raw counts in the columns that still make sense.
      cells = ['-', '-', formatCount(articlesDone), articleRate.toFixed(1), '-', `${formatGB(bytesDone)}GB`];
    }
    process.stdout.write(fitToTerminal(tableRow(cells, widths, aligns)));
  }

  // Only do real cursor-repositioning when stdout is an actual terminal —
  // on a non-TTY (redirected to a file, piped) these ANSI codes would just
  // be written as literal garbage characters, and there's no "line above"
  // to move back up to anyway.
  const isTTY = Boolean(process.stdout.isTTY);

  /**
   * Re-renders the data row in place while keeping a static bottom border
   * permanently visible below it. The row sits one line above the bottom
   * border, which sits one line above wherever the cursor currently rests
   * (see start(), which leaves the cursor there right after printing the
   * border) — so: move up 2 lines to reach the row, rewrite it, move back
   * down 2 to restore the resting position for the next call. Cursor-up/
   * down (not newlines) are pure repositioning within the terminal's
   * existing rows; they don't insert anything.
   */
  function renderInPlace() {
    if (isTTY) process.stdout.write('\x1b[2A');
    render();
    if (isTTY) process.stdout.write('\x1b[2B');
  }

  function printHeaderBlock() {
    console.log(tableBorder(widths));
    console.log(tableRow(headers, widths, headers.map(() => 'center')));
    console.log(tableBorder(widths));
  }

  return {
    addArticles(n) {
      articles.add(n);
    },
    addArticlesBurst(n) {
      articles.addBurst(n);
    },
    addBytes(n) {
      bytes.add(n);
    },
    articlesDone() {
      return articles.done; // for callers (e.g. debug-log lines) that want the corpus-wide running total, not just their own local count
    },
    totalArticles,
    start() {
      printHeaderBlock();
      render(); // first data row — cursor ends up mid-row, no newline yet
      if (isTTY) {
        process.stdout.write(`\n${tableBorder(widths)}\n`); // closes the row's line, prints the bottom border, lands on a fresh line below it
        intervalId = setInterval(renderInPlace, PROGRESS_RENDER_INTERVAL_MS);
      } else {
        intervalId = setInterval(render, PROGRESS_RENDER_INTERVAL_MS);
      }
      intervalId.unref(); // don't let this timer alone keep the process alive if something else goes wrong before finish() runs
    },
    /**
     * Prints a one-off message (a connection warning, say) above a freshly
     * reprinted table, instead of letting it land mid-table and desync
     * renderInPlace's "row is always 2 lines above the resting cursor"
     * assumption. The whole block (top border, header, separator, row,
     * bottom border — 5 lines) sits directly above that resting position, so
     * jumping up 5, wiping everything from there to the end of the screen,
     * and rebuilding it the same way start() originally laid it out restores
     * that same invariant for every renderInPlace tick afterward.
     */
    logWarning(message) {
      if (!isTTY) {
        console.log(message); // no cursor tricks to worry about when this isn't a real terminal
        return;
      }
      process.stdout.write('\x1b[5A\r\x1b[0J');
      console.log(message);
      printHeaderBlock();
      render();
      process.stdout.write(`\n${tableBorder(widths)}\n`);
    },
    finish() {
      if (intervalId) clearInterval(intervalId);
      if (isTTY) {
        renderInPlace(); // one final in-place update with the true final numbers; the bottom border is already in place from start()
      } else {
        render();
        process.stdout.write(`\n${tableBorder(widths)}\n`);
      }
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
    fs.rmSync(progressCheckpointPath(path.basename(filePath, '.tar.gz')), { force: true }); // a checkpoint from whatever wrote the corrupted archive no longer applies
    startByte = 0;
  } else if (startByte > 0) {
    // Genuinely partial — only safe to resume if the snapshot hasn't
    // rotated underneath us since whatever wrote these bytes.
    const previousEtag = fs.existsSync(etagSidecarPath) ? fs.readFileSync(etagSidecarPath, 'utf8').trim() : null;
    if (previousEtag !== etag) {
      fs.rmSync(filePath, { force: true });
      fs.rmSync(progressCheckpointPath(path.basename(filePath, '.tar.gz')), { force: true }); // same — a rotated snapshot invalidates any old line checkpoint
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

function progressCheckpointPath(chunkId) {
  return path.join(destDir, `${chunkId}.progress`);
}

/** Last NDJSON line number fully accounted for in a prior run of this exact chunk, or 0 if there's no checkpoint. */
function loadLineCheckpoint(chunkId) {
  const checkpointPath = progressCheckpointPath(chunkId);
  if (!fs.existsSync(checkpointPath)) return 0;
  const parsed = Number(fs.readFileSync(checkpointPath, 'utf8').trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function saveLineCheckpoint(chunkId, lineNumber) {
  fs.writeFileSync(progressCheckpointPath(chunkId), String(lineNumber));
}

/**
 * Streams one chunk's NDJSON, embeds every article's citation-adjacent
 * paragraphs, then deletes the raw extracted file.
 *
 * Processes ARTICLE_CONCURRENCY articles at a time (read into a batch, all
 * awaited together via Promise.all) rather than one at a time — each
 * upsertArticleEmbeddings call spends most of its wall-clock time waiting on
 * DB round-trips over a tunnel to a remote Postgres, not on local CPU, so
 * overlapping several is a close-to-linear speedup up to whatever the DB/
 * tunnel can actually sustain concurrently. Batches (not a fully streaming
 * worker pool) specifically because the checkpoint below needs a clean
 * "everything up to line N is definitely done" boundary: with a bounded
 * batch awaited via Promise.all, the checkpoint only ever advances past a
 * batch that has FULLY completed, so a crash mid-batch can't leave the
 * checkpoint claiming more progress than actually landed in Postgres.
 *
 * Logs (and checkpoints) on a time interval rather than a fixed article
 * count, so a chunk with few qualifying articles (or one that's just slow)
 * still produces visible progress instead of looking indistinguishable from
 * a hang for however long the whole chunk takes.
 */
async function embedChunkArticles(chunkId, ndjsonPath, tracker) {
  const resumeFromLine = loadLineCheckpoint(chunkId);
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  const stats = { articles: 0, paragraphs: 0, alreadyCurrent: 0, totalLines: 0 };
  let lastLoggedAt = 0;
  let lineNumber = 0;

  if (resumeFromLine > 0) {
    tracker.addArticlesBurst(resumeFromLine);
    logDebug(`${chunkId}: resuming embed from line ${resumeFromLine} (checkpoint from a prior run)`);
  }

  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;

    await Promise.all(
      batch.map(async ({ article }) => {
        const wikitext = article?.article_body?.wikitext;
        if (!article || !wikitext) return; // malformed line or a record with no embeddable body (deleted/visibility-changed/empty)
        const result = await upsertArticleEmbeddings({
          title: article.name,
          wikitext,
          versionIdentifier: article.version?.identifier,
          pageId: article.identifier,
        });
        stats.articles++;
        stats.paragraphs += result.paragraphCount;
        if (result.skipped) stats.alreadyCurrent++;
      })
    );

    // Counted per line in the batch (not just embeddable ones), so the live
    // tracker's numerator converges with recordCount (the corpus-wide
    // denominator) regardless of how many records get skipped for lacking
    // wikitext — those are still "done" from a progress-percentage
    // standpoint, just not embeddable.
    tracker.addArticles(batch.length);

    const lastLineInBatch = batch[batch.length - 1].lineNumber;
    const now = Date.now();
    if (lastLoggedAt === 0 || now - lastLoggedAt >= 10_000) {
      // Both counts, not just this chunk's own: "this session" alone tells
      // you this one chunk is alive, but not how the actual job (the thing
      // anyone tailing debug.log actually cares about) is doing overall.
      const overallDone = tracker.articlesDone();
      const overallPct = tracker.totalArticles > 0 ? ((overallDone / tracker.totalArticles) * 100).toFixed(1) : '?';
      logDebug(
        `${chunkId}: embedding in progress — ${stats.articles} articles, ${stats.paragraphs} paragraphs this chunk` +
          ` | overall: ${formatCount(overallDone)}/${formatCount(tracker.totalArticles)} articles (${overallPct}%)`
      );
      saveLineCheckpoint(chunkId, lastLineInBatch); // only ever advances past a batch that Promise.all above has already fully completed
      lastLoggedAt = now;
    }
    batch = [];
  }

  for await (const line of rl) {
    lineNumber++;
    if (lineNumber <= resumeFromLine) continue; // already accounted for by a prior run's checkpoint
    if (!line.trim()) continue;

    let article;
    try {
      article = JSON.parse(line);
    } catch {
      article = null; // still counted/checkpointed below rather than aborting the whole chunk
    }
    batch.push({ article, lineNumber });
    if (batch.length >= ARTICLE_CONCURRENCY) {
      await flushBatch();
    }
  }
  await flushBatch(); // final partial batch
  stats.totalLines = lineNumber; // the chunk's TRUE record count, known for free now that the stream has reached EOF — see processChunk's use of this for exact (not averaged) done-chunk crediting

  fs.rmSync(progressCheckpointPath(chunkId), { force: true }); // chunk fully embedded — checkpoint no longer needed, .done supersedes it
  fs.rmSync(ndjsonPath, { force: true }); // already embedded — don't keep the raw extracted copy around
  return stats;
}

/**
 * The chunk's TRUE record count if the .done marker was written by this
 * (post-fix) version of the script (a JSON blob, see processChunk), or null
 * for a .done file from before this existed (a plain ISO timestamp string,
 * not JSON) — callers fall back to avgArticlesPerChunk's estimate in that
 * case. Nothing back-fills old .done files with a real count: the archive
 * and extracted NDJSON they'd need to recount from are already deleted by
 * the time a chunk is marked done, so getting an exact count for one
 * retroactively would mean re-downloading it just to count lines. Only
 * chunks that complete from here on get the exact treatment; that's a
 * one-way ratchet toward accuracy, not a regression for older ones.
 */
function loadChunkTotalLines(donePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(donePath, 'utf8'));
    return Number.isInteger(parsed.totalLines) && parsed.totalLines > 0 ? parsed.totalLines : null;
  } catch {
    return null; // old-format (plain timestamp) .done file, or unreadable/corrupt
  }
}

/**
 * Runs one chunk through its whole lifecycle: download -> extract -> embed
 * -> cleanup -> mark done. For a chunk that's already fully .done from a
 * prior run, credits its TRUE record count (loadChunkTotalLines) when known
 * — Wikimedia's chunks aren't uniformly sized, so this is what keeps a
 * resumed run's progress display from drifting away from reality as chunks
 * of very different real sizes get credited a wrong flat average instead of
 * what they actually contain. avgArticlesPerChunk is only the fallback for
 * a chunk finished before this existed.
 */
async function processChunk(chunk, accessToken, tracker, totals, avgArticlesPerChunk) {
  const donePath = path.join(destDir, `${chunk.chunkId}.done`);
  if (fs.existsSync(donePath)) {
    tracker.addBytes(chunk.contentLength); // already fully processed in a prior run
    tracker.addArticlesBurst(loadChunkTotalLines(donePath) ?? avgArticlesPerChunk);
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

  const overallDone = tracker.articlesDone();
  const overallPct = tracker.totalArticles > 0 ? ((overallDone / tracker.totalArticles) * 100).toFixed(1) : '?';
  logDebug(
    `${chunk.chunkId}: done — ${stats.articles} articles, ${stats.paragraphs} paragraphs, ${stats.alreadyCurrent} already current` +
      ` | overall: ${formatCount(overallDone)}/${formatCount(tracker.totalArticles)} articles (${overallPct}%)`
  );
  fs.writeFileSync(donePath, JSON.stringify({ completedAt: new Date().toISOString(), totalLines: stats.totalLines }));
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

  const tracker = createProgressDisplay(recordCount, totalBytes);
  const avgArticlesPerChunk = recordCount > 0 ? recordCount / chunks.length : 0;
  const totals = { chunksDone: 0, articles: 0, paragraphs: 0, alreadyCurrent: 0 };

  // Routes DB connection-drop warnings through the table (full redraw, not a
  // bare console.error mid-row) as well as into debug.log for later tailing.
  setConnectionWarningLogger((message) => {
    logDebug(message);
    tracker.logWarning(message);
  });

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
