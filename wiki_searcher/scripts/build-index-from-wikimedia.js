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
 * copy. The next chunks are downloaded and extracted ahead of time while
 * others embed (see main's prefetch), so peak extra disk usage is up to
 * 2 × EMBED_CONCURRENCY chunks' worth of raw data, not the whole corpus.
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
 * under Wikimedia Enterprise's free-tier 10 QPS limit. EMBED_CONCURRENCY
 * (CHUNK_CONCURRENCY env, default 4) is how many chunks embed at once; each
 * holds one Postgres connection, and DB_POOL_MAX is sized to match.
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
import { upsertSpansBatch, ensureSpansTable, SPANS_TABLE, UNEMBEDDED_TABLE, SPAN_OPTIONS, setConnectionWarningLogger } from '../embeddingIndex.js';
import { setLogger as setEmbedLogger, embedConfig } from '../textEmbeddings.js';
import { formatDuration, fitToTerminal, tableBorder, tableRow } from './terminalTable.js';

loadEnv();
const execFileAsync = promisify(execFile);
// Keeps the terminal to just the aggregate progress bar — the one-time
// embedding-model-download detail (see textEmbeddings.js) goes to debug.log
// instead, same as every other per-chunk stage transition below.
let activeTracker = null; // the live progress display, once main() has created it
setEmbedLogger((message) => {
  logDebug(message);
  const status = modelStatusFrom(message);
  if (status && activeTracker) activeTracker.setModelStatus(status);
});

/** The model-loading lines textEmbeddings.js logs, reduced to a few words for the status line. */
function modelStatusFrom(message) {
  let m;
  if ((m = /^\[embed\] Loading /.exec(message))) return 'loading';
  if ((m = /^\[embed\] Downloading (\S+)/.exec(message))) return `downloading ${m[1]}`;
  if ((m = /^\[embed\]\s+(\S+): (\d+)%/.exec(message))) return `downloading ${m[1]} ${m[2]}%`;
  if (/^\[embed\]\s+\S+: done/.test(message)) return 'downloaded, loading';
  if (/^\[embed\] Model ready/.test(message)) return 'ready';
  return null;
}

const API_BASE = 'https://api.enterprise.wikimedia.com';
const identifier = process.argv[2] || 'enwiki_namespace_0';
const destDir = process.argv[3] || './wiki-snapshots-v2'; // v2: the cited-span rebuild keeps its own state, separate from the old paragraph build's
const CONCURRENCY = 6; // sizing pass only — pure network, raise if you're on a paid plan with a higher QPS limit
// Chunks in flight at once (CHUNK_CONCURRENCY env, default 4). Each chunk
// processes its batches strictly in sequence (read → embed → write), so most
// of a chunk's time is spent waiting on DB round trips over the tunnel; more
// chunks in parallel overlaps more of that waiting. Costs disk (each chunk in
// flight holds its archive + extracted NDJSON) and one DB connection each.
// Safe to change between runs: every chunk resumes from its own checkpoint.
const EMBED_CONCURRENCY = Number(process.env.CHUNK_CONCURRENCY) || 4;
// CHUNK_SHARD=k/n: this process takes every n-th chunk starting at k (0-based),
// so several processes — a second one on the same machine, or a Railway
// service writing over the internal network — can build disjoint slices of
// the snapshot into the same tables at once. Give each its own state dir
// (3rd argument) when they share a filesystem. Unset = all chunks.
const CHUNK_SHARD = (() => {
  const raw = process.env.CHUNK_SHARD;
  if (!raw) return null;
  const m = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (!m || Number(m[2]) < 1 || Number(m[1]) >= Number(m[2])) throw new Error(`CHUNK_SHARD must look like k/n with 0 ≤ k < n, got "${raw}"`);
  return { index: Number(m[1]), count: Number(m[2]) };
})();
// Articles per upsertSpansBatch call (ARTICLES_PER_BATCH env, default 100):
// one embedding call and ONE transaction of a dozen or so statements per
// batch. Over the tunnel every statement is a ~100–250 ms round trip, so the
// batch size is what sets the per-article write cost: at 8 articles a batch
// the write phase measured 435 ms per article against 17 ms of embedding; at
// 100 it is ~12x less. Each chunk still holds ONE DB connection regardless,
// so DB_POOL_MAX below only needs EMBED_CONCURRENCY (+ headroom). Costs
// memory per chunk in flight (100 articles' HTML ≈ 10 MB) and makes the
// per-chunk checkpoint coarser; safe to change between runs.
const ARTICLE_CONCURRENCY = Number(process.env.ARTICLES_PER_BATCH) || 100;
process.env.DB_POOL_MAX ??= String(EMBED_CONCURRENCY + 2);
// A batch of hundreds of articles over a slow tunnel can legitimately take
// longer than db.js's 30 s default statement timeout; a cancelled statement
// would just be retried, wasting the work. 10 minutes, unless set already.
process.env.DB_STATEMENT_TIMEOUT_MS ??= '600000';
// A chunk that keeps failing (download, extraction, or a batch that gave up)
// is retried this many times with growing pauses, then set aside and
// reported at the end; the run goes on with the others.
const CHUNK_MAX_ATTEMPTS = 6;
const CHUNK_RETRY_BASE_DELAY_MS = 30_000;
const CHUNK_RETRY_MAX_DELAY_MS = 10 * 60_000; // one connection per chunk in flight (see ARTICLE_CONCURRENCY above) + 2 headroom for other occasional queries (refresh-daily.js, etc. sharing the same Postgres); only takes effect if the user hasn't already set this themselves
const METADATA_TIMEOUT_MS = 15_000; // HEAD/info calls should be fast; don't hang forever if one stalls
const STALL_TIMEOUT_MS = 30_000; // abort a chunk download if no bytes arrive for this long
const CONSOLE_WARN_THROTTLE_MS = 10_000; // cap how often a retrying download repaints the live console (debug.log still gets every attempt)

const PROGRESS_BAR_WIDTH = 30; // fitToTerminal() truncates safely on a narrow terminal, so there's no need to keep this cramped for width's sake
const PROGRESS_RENDER_INTERVAL_MS = 200;
// Elapsed (the table column) is active build time over ALL runs, persisted
// in destDir/elapsed.json. A pause longer than this with no observable
// progress (a dropped tunnel, a sleeping laptop, the process not running) is
// not counted; shorter gaps are. 30 s rather than 10 because one embedding
// batch of large articles on a CPU can legitimately take that long between
// counter updates.
const STALL_EXCLUDE_MS = 30_000;
const ELAPSED_SAVE_INTERVAL_MS = 5_000;
// Sharded runs (CHUNK_SHARD) share progress through small files in
// BUILD_PROGRESS_DIR, one per shard, rewritten every PROGRESS_SHARE_INTERVAL_MS,
// so every process can show the same corpus-wide Progress/Articles/ETA. A
// shard whose file is older than SHARD_STALE_MS is treated as not running.
const PROGRESS_DIR = process.env.BUILD_PROGRESS_DIR || './wiki-build-progress';
const PROGRESS_SHARE_INTERVAL_MS = 2_000;
const SHARD_STALE_MS = 90_000;
// Long enough to span several ARTICLE_CONCURRENCY batch-flush cycles (so
// Art/s doesn't swing between "a batch just landed" and "nothing yet," the
// problem with the old 5s window), short enough to actually reflect a real
// slowdown/speedup well before the whole-run average (ETA's basis) would.
const RECENT_RATE_WINDOW_MS = 20_000;

function formatGB(bytes) {
  return (bytes / 1e9).toFixed(2);
}

/** Compact, ~2-significant-figure formatting ("850K" / "7.3M") — a raw comma-grouped 7,332,159 is needlessly wide for a one-line status display. */
function formatCount(n) {
  if (n >= 1e6) return (n / 1e6 >= 10 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)) + 'M';
  if (n >= 1e3) return (n / 1e3 >= 10 ? Math.round(n / 1e3) : (n / 1e3).toFixed(1)) + 'K';
  return String(Math.round(n));
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

      return { done, realDone, rate, recentRate };
    },
  };
}

/**
 * Tracks a rolling average of how long one stage's calls have recently taken
 * (as opposed to createCounter's rate-of-progress) — the basis for the
 * Embed ms / DB ms columns below. A stage that's genuinely the bottleneck
 * shows up here as a rising recent average well before it'd be obvious from
 * Art/s alone, the same "recent window, not lifetime average" reasoning as
 * RECENT_RATE_WINDOW_MS (see createCounter above).
 */
function createStageTimer() {
  const samples = []; // { time, ms }, pruned to RECENT_RATE_WINDOW_MS
  return {
    record(ms) {
      const now = Date.now();
      samples.push({ time: now, ms });
      while (samples.length > 1 && now - samples[0].time > RECENT_RATE_WINDOW_MS) samples.shift();
    },
    recentAvgMs() {
      if (samples.length === 0) return 0;
      return samples.reduce((sum, s) => sum + s.ms, 0) / samples.length;
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
/**
 * @param {number} totalArticles - articles this process is responsible for (its shard's share when sharded)
 * @param {number} chunkSlots
 * @param {{ index: number, count: number, corpusArticles: number } | null} shard - set in a sharded run: Progress/Articles/ETA then cover all shards
 */
function createProgressDisplay(totalArticles, chunkSlots, shard = null) {
  const articles = createCounter();
  const bytes = createCounter();
  const stageNames = ['embed', 'read', 'write'];
  const stageTimers = Object.fromEntries(stageNames.map((name) => [name, createStageTimer()]));
  const stages = new Map(); // chunkId → { stage: 'downloading' | 'extracting' | 'embedding', done, total } (bytes, for downloads)
  let modelStatus = null;
  let intervalId = null;

  // Elapsed: this session's wall clock for the status line; active time over
  // all runs for the table column (see STALL_EXCLUDE_MS).
  const elapsedPath = path.join(destDir, 'elapsed.json');
  const sessionStart = Date.now();
  let activeMs = 0;
  try {
    activeMs = Number(JSON.parse(fs.readFileSync(elapsedPath, 'utf8')).activeMs) || 0;
  } catch {
    activeMs = 0; // first run, or unreadable: start from zero
  }
  let lastTick = sessionStart;
  let lastProgressAt = sessionStart;
  let lastSignature = '';
  let stallExcluded = false;
  let lastSavedAt = sessionStart;

  // Sharded run: publish this process's progress and read the other shards'.
  const statusLineCount = shard ? 2 : 1;
  const blockHeight = statusLineCount + 5; // status line(s) + top border + header + separator + row + bottom border
  const shardFile = (k) => path.join(PROGRESS_DIR, `shard-${k}-of-${shard.count}.json`);
  let lastShareAt = 0;
  let peers = []; // one entry per shard, this one included; refreshed every PROGRESS_SHARE_INTERVAL_MS
  function shareAndReadPeers(now, own) {
    if (!shard || now - lastShareAt < PROGRESS_SHARE_INTERVAL_MS) return;
    lastShareAt = now;
    const mine = { shard: shard.index, shards: shard.count, pid: process.pid, articlesDone: own.done, totalArticles, realDone: own.realDone, recentRate: own.recentRate, startedAt: sessionStart, updatedAt: now };
    try {
      fs.mkdirSync(PROGRESS_DIR, { recursive: true });
      fs.writeFileSync(`${shardFile(shard.index)}.tmp`, JSON.stringify(mine));
      fs.renameSync(`${shardFile(shard.index)}.tmp`, shardFile(shard.index)); // atomic: a reader never sees a half-written file
    } catch {
      // unwritable progress dir: the other shards just won't see this one
    }
    peers = [];
    for (let k = 0; k < shard.count; k++) {
      if (k === shard.index) {
        peers.push({ ...mine, stale: false, missing: false });
        continue;
      }
      try {
        const record = JSON.parse(fs.readFileSync(shardFile(k), 'utf8'));
        peers.push({ ...record, stale: now - record.updatedAt > SHARD_STALE_MS, missing: false });
      } catch {
        // never started (or its file is gone): count its share of the corpus as not done
        peers.push({ shard: k, articlesDone: 0, totalArticles: Math.round(shard.corpusArticles / shard.count), realDone: 0, recentRate: 0, startedAt: now, updatedAt: 0, stale: false, missing: true });
      }
    }
  }
  /** Corpus-wide numbers across shards. ETA = when the slowest live shard finishes; unknown while any shard is missing or stale and still has work. */
  function overallProgress(now) {
    let done = 0;
    let total = 0;
    let etaSeconds = 0;
    let unknown = false;
    let combinedRate = 0;
    let live = 0;
    for (const peer of peers) {
      done += peer.articlesDone;
      total += peer.totalArticles;
      const remaining = peer.totalArticles - peer.articlesDone;
      if (peer.missing || peer.stale) {
        if (remaining > 0) unknown = true;
        continue;
      }
      live++;
      combinedRate += peer.recentRate || 0;
      if (remaining <= 0) continue;
      const elapsed = (now - peer.startedAt) / 1000;
      const rate = elapsed > 0 ? peer.realDone / elapsed : 0;
      if (rate <= 0) unknown = true;
      else etaSeconds = Math.max(etaSeconds, remaining / rate);
    }
    return { done, total, etaSeconds: unknown ? NaN : etaSeconds, combinedRate, live };
  }

  function saveActive() {
    try {
      fs.writeFileSync(elapsedPath, JSON.stringify({ activeMs: Math.round(activeMs), savedAt: new Date().toISOString() }));
    } catch {
      // the state dir vanished mid-run; the column keeps counting in memory
    }
    lastSavedAt = Date.now();
  }

  /** Advances active time: called every render tick. Progress = any counter or stage changed; extraction and model loading count as progress (they have no counters). */
  function tickElapsed() {
    const now = Date.now();
    const signature = `${articles.done}|${bytes.done}|${[...stages].map(([id, st]) => `${id}:${st.stage}:${st.done}`).join(',')}|${modelStatus}`;
    const inherentlyBusy = [...stages.values()].some((st) => st.stage === 'extracting') || /^(loading|downloading|downloaded)/.test(modelStatus ?? '');
    if (signature !== lastSignature || inherentlyBusy) {
      lastSignature = signature;
      lastProgressAt = now;
      stallExcluded = false;
    }
    const delta = now - lastTick;
    lastTick = now;
    if (now - lastProgressAt <= STALL_EXCLUDE_MS) {
      activeMs += delta;
    } else if (!stallExcluded) {
      activeMs = Math.max(0, activeMs - STALL_EXCLUDE_MS); // the stall turned out long: take back the part already counted
      stallExcluded = true;
    }
    if (now - lastSavedAt >= ELAPSED_SAVE_INTERVAL_MS) saveActive();
  }

  function statusText() {
    const parts = [`Session ${formatDuration((Date.now() - sessionStart) / 1000)}`];
    const byStage = (stage) => [...stages.values()].filter((st) => st.stage === stage);
    const downloading = byStage('downloading');
    const slotParts = [];
    if (downloading.length) {
      const total = downloading.reduce((sum, st) => sum + (st.total || 0), 0);
      const done = downloading.reduce((sum, st) => sum + st.done, 0);
      slotParts.push(`downloading ${downloading.length}${total ? ` (${Math.min(100, (done / total) * 100).toFixed(0)}%)` : ''}`);
    }
    if (byStage('extracting').length) slotParts.push(`extracting ${byStage('extracting').length}`);
    if (byStage('embedding').length) slotParts.push(`embedding ${byStage('embedding').length}`);
    parts.push(`chunks: ${slotParts.length ? slotParts.join(', ') : 'none in flight'}`);
    parts.push(`model: ${modelStatus ?? 'loads on the first batch'}`);
    const lines = [fitToTerminal(parts.join(' | '))];
    if (shard) {
      const now = Date.now();
      const { combinedRate, live } = overallProgress(now);
      const shardParts = [
        `Shards: this is ${shard.index}/${shard.count} at ${formatCount(articles.done)}/${formatCount(totalArticles)}`,
        `${live}/${shard.count} live`,
        `combined ${combinedRate.toFixed(1)} art/s`,
      ];
      for (const peer of peers) {
        if (peer.missing) shardParts.push(`shard ${peer.shard}: not started`);
        else if (peer.stale) shardParts.push(`shard ${peer.shard}: stale ${formatDuration((now - peer.updatedAt) / 1000)}`);
      }
      lines.push(fitToTerminal(shardParts.join(' · ')));
    }
    return lines;
  }

  // Embed / Read / Write: milliseconds per article within one chunk, reported
  // once per batch (see embedChunkArticles' flushBatch). They add up to an
  // embedding chunk's time per article, so Art/s ≈ Busy × 1000 / their sum.
  // Read is the tiny already-current query, Write the big DELETE+INSERT
  // upload — comparing them separates tunnel latency from tunnel bandwidth.
  // Busy: chunks embedding right now / chunk slots. Below full means slots
  // are waiting on a download or extraction (see main's prefetch).
  const headers = ['Progress', 'Articles', 'ETA', 'Elapsed', 'Art/s', 'DL MB/s', 'Embed', 'Read', 'Write', 'Busy'];
  const widths = [
    Math.max(headers[0].length, PROGRESS_BAR_WIDTH + 2 + 1 + 6), // "[" + bar + "]" + " " + "100.0%"
    Math.max(headers[1].length, formatCount(shard ? shard.corpusArticles : totalArticles).length * 2 + 1), // "done/total", sized to the known total on both sides
    Math.max(headers[2].length, 7), // "999d23h"-ish worst case
    Math.max(headers[3].length, 7), // active time over all runs, same format
    Math.max(headers[4].length, 6), // rate, e.g. "9999.9"
    Math.max(headers[5].length, 7), // rate, e.g. "9999.9"
    ...stageNames.map((_, i) => Math.max(headers[6 + i].length, 5)), // whole ms, e.g. "99999"
    Math.max(headers[9].length, String(chunkSlots).length * 2 + 1), // "4/4"
  ];
  const aligns = headers.map((_, i) => (i === 0 ? 'left' : 'right'));

  function render() {
    tickElapsed();
    // rate (lifetime average) drives the ETA; recentRate (short rolling
    // window) drives the displayed Art/s — see createCounter's comment for
    // why these are deliberately different numbers.
    const own = articles.stats();
    const { done: ownDone, rate: lifetimeRate, recentRate: articleRate } = own;
    const { recentRate: bytesRate } = bytes.stats();
    shareAndReadPeers(Date.now(), own);
    // Sharded: the bar, count and ETA describe the whole corpus (identical in
    // every process); the per-process columns describe this one.
    const scope = shard ? overallProgress(Date.now()) : null;
    const articlesDone = scope ? scope.done : ownDone;
    const scopeTotal = scope ? scope.total : totalArticles;
    const embeddingCount = [...stages.values()].filter((st) => st.stage === 'embedding').length;
    const speedCells = [
      formatDuration(activeMs / 1000),
      articleRate.toFixed(1),
      (bytesRate / 1e6).toFixed(1),
      ...stageNames.map((name) => stageTimers[name].recentAvgMs().toFixed(0)),
      `${embeddingCount}/${chunkSlots}`,
    ];

    let cells;
    if (scopeTotal > 0) {
      const remaining = scopeTotal - articlesDone;
      const etaSeconds = scope ? scope.etaSeconds : lifetimeRate > 0 ? remaining / lifetimeRate : NaN;
      const fraction = Math.min(1, articlesDone / scopeTotal);
      const filled = Math.round(fraction * PROGRESS_BAR_WIDTH);
      const bar = '[' + '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled) + ']';
      cells = [
        `${bar} ${(fraction * 100).toFixed(1)}%`,
        `${formatCount(articlesDone)}/${formatCount(scopeTotal)}`,
        formatDuration(etaSeconds),
        ...speedCells,
      ];
    } else {
      // No article-count denominator to compute a % or ETA against — fall back to raw counts in the columns that still make sense.
      cells = ['-', formatCount(articlesDone), '-', ...speedCells];
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
    if (isTTY) {
      // Up to the first status line, rewrite each status line (ending on the
      // top border's line), then down to the data row.
      process.stdout.write(`\x1b[${blockHeight}A\r`);
      for (const line of statusText()) process.stdout.write(`\x1b[2K${line}\n`);
      process.stdout.write('\x1b[3B\r');
    }
    render();
    if (isTTY) process.stdout.write('\x1b[2B\r');
  }

  let lastPrintedStatus = '';
  function printHeaderBlock() {
    const lines = statusText();
    lastPrintedStatus = lines.join('\n');
    for (const line of lines) console.log(line);
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
    /** Bytes already on disk from a prior run: counted toward the total, not toward DL MB/s (see createCounter's addBurst). */
    addBytesBurst(n) {
      bytes.addBurst(n);
    },
    /** One batch's per-article ms for each stage: { embed, read, write }. */
    recordBatchTimings(perArticleMs) {
      for (const name of stageNames) stageTimers[name].record(perArticleMs[name]);
    },
    /** What a chunk slot is doing right now, for the status line and Busy; `null` clears it. `total` = bytes to download. */
    setChunkStage(chunkId, stage, total = 0) {
      if (!stage) stages.delete(chunkId);
      else stages.set(chunkId, { stage, done: stages.get(chunkId)?.stage === stage ? stages.get(chunkId).done : 0, total });
    },
    /** Bytes landed for one downloading chunk (negative on a retried attempt), for the download percentage. */
    addChunkBytes(chunkId, n) {
      const st = stages.get(chunkId);
      if (st) st.done = Math.max(0, st.done + n);
    },
    setChunkEmbedding(chunkId, isEmbedding) {
      this.setChunkStage(chunkId, isEmbedding ? 'embedding' : null);
    },
    setModelStatus(status) {
      modelStatus = status;
    },
    articlesDone() {
      return articles.done; // for callers (e.g. debug-log lines) that want the corpus-wide running total, not just their own local count
    },
    totalArticles,
    start() {
      shareAndReadPeers(Date.now(), articles.stats()); // so the very first status line already knows the other shards
      printHeaderBlock();
      render(); // first data row — cursor ends up mid-row, no newline yet
      if (isTTY) {
        process.stdout.write(`\n${tableBorder(widths)}\n`); // closes the row's line, prints the bottom border, lands on a fresh line below it
        intervalId = setInterval(renderInPlace, PROGRESS_RENDER_INTERVAL_MS);
      } else {
        // Not a terminal (piped/redirected): one row per tick, and the status
        // line again whenever what the slots are doing changes.
        intervalId = setInterval(() => {
          const lines = statusText();
          const status = lines.join('\n').replace(/^Session \S+/, '');
          if (status !== lastPrintedStatus.replace(/^Session \S+/, '')) {
            lastPrintedStatus = lines.join('\n');
            process.stdout.write(`\n${lastPrintedStatus}\n`);
          }
          render();
          process.stdout.write('\n');
        }, PROGRESS_RENDER_INTERVAL_MS);
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
      process.stdout.write(`\x1b[${blockHeight}A\r\x1b[0J`);
      console.log(message);
      printHeaderBlock();
      render();
      process.stdout.write(`\n${tableBorder(widths)}\n`);
    },
    finish() {
      if (intervalId) clearInterval(intervalId);
      tickElapsed();
      saveActive();
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

/**
 * Authorization header with a currently-valid token. Fetched per request, not
 * once per run: access tokens expire after 24h, and a run that held one token
 * for longer than that died on its next download with a non-retryable 401.
 * getAccessToken caches the token and refreshes it shortly before expiry, so
 * this is cheap.
 */
async function authHeader() {
  return { Authorization: `Bearer ${await getAccessToken()}` };
}

async function fetchJson(url, method = 'GET') {
  return withRetry('snapshot_info', async () => {
    const response = await fetch(url, {
      method,
      headers: await authHeader(),
      signal: timeoutSignal(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throwForBadResponse(response, `${method} ${url} failed: ${response.status} ${response.statusText}`);
    return response.json();
  });
}

async function headDownload(url) {
  return withRetry('snapshot_head', async () => {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: await authHeader(),
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
async function downloadOne(url, filePath, tracker, metadata) {
  // `let`, not `const`: a "received more bytes than reported size" failure
  // (see the catch block below) means this cached HEAD data is stale, and
  // gets refreshed in place so later attempts stop re-hitting the same
  // wrong ceiling.
  let { contentLength, etag, acceptsRanges } = metadata;
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
    tracker.addBytesBurst(startByte);
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
  tracker.addBytesBurst(startByte); // whatever we're keeping/resuming from, credited exactly once, right here
  fs.writeFileSync(etagSidecarPath, etag ?? '');


  let alreadyComplete = false;
  // Retries effectively forever (a huge but finite ceiling, so a genuinely
  // non-retryable failure -- callExternalApi still throws immediately for a
  // 4xx like an expired token -- isn't silently hidden either) rather than
  // the default 4. Confirmed from callExternalApi's own backoff math (capped
  // at 5s/attempt) that 4 retries is only ~15-20s of total backoff plus up
  // to 4 more STALL_TIMEOUT_MS waits -- nowhere near enough to survive a
  // multi-minute network blip, which is exactly what's been happening here
  // (observed live: downloads failing in various ways after the laptop's
  // display sleeps, even with full system sleep disabled -- display sleep
  // alone is enough to interrupt Wi-Fi for a while on macOS). A long-running
  // background download should wait this kind of thing out, not give up and
  // take the whole multi-day job down with it.
  //
  // But retrying effectively forever MUST be loud, not silent -- caused a
  // real incident: callExternalApi's own retry loop doesn't log anywhere
  // (its recordRetryMetric/addTraceEvent calls are internal telemetry, not
  // console/debug.log output), so a chunk stuck retrying a persistently bad
  // download held one of EMBED_CONCURRENCY's 4 worker slots hostage with
  // ZERO visible indication anything was wrong -- just 3 of the 4 chunks
  // going completely silent in debug.log for minutes on end, while overall
  // throughput quietly dropped to a quarter of normal. attemptNumber below
  // and the logging in the catch block make every single retry visible,
  // both in debug.log and on the live console (matching the exact same
  // "retry forever, but tell me when it happens" principle already used for
  // DB connection retries).
  let attemptNumber = 0;
  let lastConsoleWarnAt = 0;
  await withRetry(
    'snapshot_chunk_download',
    async () => {
      attemptNumber++;
      // Re-check on every retry attempt — a prior attempt may have written
      // some bytes before failing, so this needs to reflect what's on disk
      // right now, not what it was when downloadOne started.
      const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      const attemptHeaders = await authHeader(); // per attempt: a download retrying for hours can outlive a token
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
        // Without this, a write that completes (or fails) asynchronously
        // AFTER the stream has already been destroyed — e.g. racing the
        // catch block's destroy() below against a stall-triggered abort —
        // emits an 'error' event with nothing listening for it. Node treats
        // an unlistened 'error' event as fatal and crashes the WHOLE
        // process (observed live: "Unhandled 'error' event" /
        // ERR_STREAM_DESTROYED, taking down a multi-day run over what's
        // really a transient I/O race). The actual correctness backstop
        // here is the completeness check below, not this stream's own error
        // reporting, so it's safe to just log and move on — a short/failed
        // write surfaces as a size mismatch and gets retried either way.
        writeStream.on('error', (err) => {
          logDebug(`${path.basename(filePath)}: write stream error (likely a benign write-after-destroy race from a stall/abort) — ${err.message}`);
        });
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

        // The response body can end cleanly (no thrown error at all) while
        // still having delivered fewer bytes than it promised — observed
        // live as a "Size mismatch" fatal error thrown AFTER this whole
        // retry call had already returned successfully, meaning it was
        // never actually retried. Checking per-attempt, inside the retry
        // loop, is what makes a silently truncated response get another
        // attempt instead of being a one-shot fatal error for the whole
        // process.
        if (Number.isFinite(contentLength) && contentLength > 0 && currentSize + bytesThisAttempt !== contentLength) {
          const shortfallError = new Error(
            `${path.basename(filePath)}: response ended after ${bytesThisAttempt} bytes this attempt, but ` +
              `${contentLength - currentSize} were expected (${currentSize + bytesThisAttempt}/${contentLength} total) — retrying.`
          );
          // writeStream.end() above already resolved successfully -- every
          // one of these bytes is confirmed written and good, just short of
          // the full chunk. Flagged so the catch block below keeps them
          // instead of rolling back to currentSize. Observed live keeping
          // the OLD rollback-everything behavior: the next attempt re-reads
          // the exact same currentSize and sends the exact same Range
          // request, so a response that deterministically truncates at the
          // same point (a flaky CDN edge serving a cached partial response,
          // for instance -- two different chunks were seen truncating at
          // the identical byte count on every single retry) can never
          // succeed no matter how many times it's retried. Keeping the good
          // bytes means the next attempt asks for a smaller, different
          // remaining range instead of repeating a request that's already
          // proven to fail.
          shortfallError.isCleanShortResponse = true;
          throw shortfallError;
        }
      } catch (error) {
        if (error.isCleanShortResponse) {
          // See where this is thrown above -- these bytes are confirmed
          // good (the stream already ended normally), so no rollback.
        } else {
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
        }

        // "Received more bytes than its reported size" repeating with
        // essentially the SAME overshoot on every attempt (observed live:
        // off by the same few KB, over and over, against a ~345MB chunk)
        // isn't a transient failure at all -- it means contentLength itself
        // (cached in snapshot-metadata.json, possibly weeks stale)
        // understates this chunk's true current size. No amount of
        // retrying against the same wrong ceiling will ever succeed.
        // Refreshing it here, in place, is what makes the next attempt
        // retry against the REAL size instead of repeating a doomed check
        // forever.
        if (/received more bytes than its reported size/.test(error.message)) {
          try {
            const fresh = await headDownload(url);
            contentLength = fresh.contentLength;
            etag = fresh.etag;
            acceptsRanges = fresh.acceptsRanges;
            logDebug(`${path.basename(filePath)}: cached size was stale — refreshed via HEAD, true size is ${contentLength}`);
          } catch {
            // best-effort -- if the refresh itself fails, retry with the old expectation; it'll hit the same wall and try to refresh again next attempt
          }
        }

        const failure =
          error.name === 'AbortError'
            ? new Error(`Chunk stalled — no data received for ${STALL_TIMEOUT_MS / 1000}s (${path.basename(filePath)}).`)
            : error;
        const message = `${path.basename(filePath)}: download attempt ${attemptNumber} failed — ${failure.message}`;
        logDebug(message);
        // The live console warning (a full table redraw) is throttled
        // separately from debug.log -- every attempt is always logged to
        // disk, but a chunk retrying rapidly shouldn't repaint the console
        // on every single one of them.
        const now = Date.now();
        if (now - lastConsoleWarnAt >= CONSOLE_WARN_THROTTLE_MS) {
          tracker.logWarning(`⚠ ${message} — retrying`);
          lastConsoleWarnAt = now;
        }
        throw failure;
      } finally {
        clearTimeout(stallTimer);
      }
    },
    100_000 // see comment above withRetry call — effectively unbounded, not the default 4
  );

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
      const index = cursor++;
      await worker(items[index], index);
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
 * Processes ARTICLE_CONCURRENCY articles at a time, as one batch handed to
 * upsertSpansBatch (embeddingIndex.js) rather than one call per article —
 * each article's own DB round-trips over the tunnel to a remote Postgres pay
 * a fixed latency cost regardless of concurrency, so batching them into (at
 * most) two round-trips for the WHOLE group of articles cuts that overhead
 * directly instead of just overlapping it. Batches (not a fully streaming
 * worker pool) specifically because the checkpoint below needs a clean
 * "everything up to line N is definitely done" boundary: with a bounded
 * batch, the checkpoint only ever advances past a batch that has FULLY
 * completed, so a crash mid-batch can't leave the checkpoint claiming more
 * progress than actually landed in Postgres.
 *
 * Logs (and checkpoints) on a time interval rather than a fixed article
 * count, so a chunk with few qualifying articles (or one that's just slow)
 * still produces visible progress instead of looking indistinguishable from
 * a hang for however long the whole chunk takes.
 */
async function embedChunkArticles(chunkId, ndjsonPath, tracker) {
  const resumeFromLine = loadLineCheckpoint(chunkId);
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  const stats = { articles: 0, spans: 0, unembedded: 0, alreadyCurrent: 0, totalLines: 0, failedBatches: 0 };
  let lastLoggedAt = 0;
  let lineNumber = 0;

  if (resumeFromLine > 0) {
    tracker.addArticlesBurst(resumeFromLine);
    logDebug(`${chunkId}: resuming embed from line ${resumeFromLine} (checkpoint from a prior run)`);
  }

  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;

    // Malformed lines or records with no embeddable body (deleted/
    // visibility-changed/empty) never reach the DB at all — same as before,
    // just filtered up front instead of bailing out of a per-article call.
    const embeddable = batch.filter(({ article }) => article?.article_body?.html);
    const timings = { readMs: 0, embedMs: 0, writeMs: 0 };
    if (embeddable.length > 0) {
      try {
        const results = await upsertSpansBatch(
          embeddable.map(({ article }) => ({
            title: article.name,
            html: article.article_body.html,
            versionIdentifier: article.version?.identifier,
            pageId: article.identifier,
          })),
          timings
        );
        for (const result of results) {
          stats.articles++;
          stats.spans += result.spanCount;
          stats.unembedded += result.unembeddedCount ?? 0;
          if (result.skipped) stats.alreadyCurrent++;
        }
      } catch (error) {
        // upsertSpansBatch already retried (connection errors forever, anything
        // else a few times). Record the batch and move on; the chunk is left
        // re-runnable (no .done marker, see below) so a re-run redoes it.
        stats.failedBatches++;
        const record = {
          at: new Date().toISOString(),
          chunkId,
          lines: [batch[0].lineNumber, batch[batch.length - 1].lineNumber],
          titles: embeddable.map(({ article }) => article.name),
          error: error.message,
        };
        try {
          fs.appendFileSync(path.join(destDir, 'failed-batches.ndjson'), JSON.stringify(record) + '\n');
        } catch {
          // disk trouble: debug.log below still has it
        }
        const message = `⚠ ${chunkId}: batch at lines ${record.lines[0]}–${record.lines[1]} (${embeddable.length} articles) failed and was skipped — ${error.message}`;
        logDebug(message);
        tracker.logWarning(message);
      }
    }

    // Per-article stage times for the table, one sample per batch (zeros for
    // stages this batch skipped, so the averages stay honest).
    tracker.recordBatchTimings({
      embed: timings.embedMs / batch.length,
      read: timings.readMs / batch.length,
      write: timings.writeMs / batch.length,
    });

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
        `${chunkId}: embedding in progress — ${stats.articles} articles, ${stats.spans} spans embedded, ${stats.unembedded} stored unembedded this chunk` +
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
  if (stats.failedBatches > 0) {
    // Keep the extracted file and leave the chunk without a .done marker: a
    // re-run picks it straight up from disk and redoes it; articles already
    // stored are skipped by the version check, the failed ones get written.
    logDebug(`${chunkId}: ${stats.failedBatches} batch(es) failed — not marking done; re-run to redo this chunk from its extracted file`);
  } else {
    fs.rmSync(ndjsonPath, { force: true }); // already embedded — don't keep the raw extracted copy around
  }
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

function donePathFor(chunk) {
  return path.join(destDir, `${chunk.chunkId}.done`);
}

/**
 * Gets one chunk ready to embed and returns its extracted NDJSON path:
 * downloads and extracts it, unless a prior run already left the extracted
 * .ndjson on disk. Separate from processChunk so upcoming chunks can be
 * prepared while others embed (see main's prefetch); otherwise every chunk
 * slot sat idle through its whole download + extraction before embedding.
 */
async function prepareChunk(chunk, tracker) {
  const alreadyExtractedPath = path.join(destDir, `${chunk.chunkId}.ndjson`);
  if (fs.existsSync(alreadyExtractedPath)) {
    // Downloaded and extracted in a prior run, but not yet embedded when
    // that run stopped — pick up from here instead of re-downloading.
    logDebug(`${chunk.chunkId}: resuming from already-extracted .ndjson, skipping straight to embedding`);
    tracker.addBytesBurst(chunk.contentLength);
    return alreadyExtractedPath;
  }
  logDebug(`${chunk.chunkId}: starting download`);
  tracker.setChunkStage(chunk.chunkId, 'downloading', chunk.contentLength);
  // The download reports bytes to the shared counters; this also attributes
  // them to the chunk so the status line can show how far its download is.
  const chunkTracker = {
    ...tracker,
    addBytes(n) {
      tracker.addBytes(n);
      tracker.addChunkBytes(chunk.chunkId, n);
    },
    addBytesBurst(n) {
      tracker.addBytesBurst(n);
      tracker.addChunkBytes(chunk.chunkId, n);
    },
  };
  try {
    await downloadOne(chunk.url, chunk.filePath, chunkTracker, {
      contentLength: chunk.contentLength,
      etag: chunk.etag,
      acceptsRanges: chunk.acceptsRanges,
    });
    logDebug(`${chunk.chunkId}: download complete, extracting`);
    tracker.setChunkStage(chunk.chunkId, 'extracting');
    const ndjsonPath = await extractChunk(chunk);
    logDebug(`${chunk.chunkId}: extraction complete, ready to embed`);
    return ndjsonPath;
  } finally {
    tracker.setChunkStage(chunk.chunkId, null);
  }
}

/**
 * Runs one chunk through embed -> cleanup -> mark done, after awaiting its
 * preparation (`prepare(chunk)` — usually already started ahead of time, see
 * main). For a chunk that's already fully .done from a prior run, credits its
 * TRUE record count (loadChunkTotalLines) when known — Wikimedia's chunks
 * aren't uniformly sized, so this is what keeps a resumed run's progress
 * display from drifting away from reality as chunks of very different real
 * sizes get credited a wrong flat average instead of what they actually
 * contain. avgArticlesPerChunk is only the fallback for a chunk finished
 * before this existed.
 */
async function processChunk(chunk, prepare, unprepare, tracker, totals, avgArticlesPerChunk) {
  const donePath = donePathFor(chunk);
  if (fs.existsSync(donePath)) {
    tracker.addBytesBurst(chunk.contentLength); // already fully processed in a prior run
    tracker.addArticlesBurst(loadChunkTotalLines(donePath) ?? avgArticlesPerChunk);
    return;
  }

  // Anything that escapes a chunk (a download that gave up, a broken archive,
  // a batch that failed after its own retries, a bug) is retried at the
  // chunk level with a growing pause, and finally set aside — never allowed
  // to take the whole run down. The chunk's own checkpoint means a retry
  // resumes rather than restarts.
  for (let attempt = 1; ; attempt++) {
    try {
      await processChunkOnce(chunk, prepare, tracker, totals);
      return;
    } catch (error) {
      unprepare(chunk); // a retry re-runs the download/extraction (resuming the partial file) instead of reusing a failed promise
      tracker.setChunkEmbedding(chunk.chunkId, false);
      const detail = `${error.message}${error.detail ? ` (${error.detail})` : ''}`;
      if (attempt >= CHUNK_MAX_ATTEMPTS) {
        totals.failedChunks.push({ chunkId: chunk.chunkId, error: detail });
        const message = `✗ ${chunk.chunkId}: giving up after ${attempt} attempts — ${detail}. Set aside; re-run the script later to retry it.`;
        logDebug(message);
        tracker.logWarning(message);
        return;
      }
      const delayMs = Math.min(CHUNK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), CHUNK_RETRY_MAX_DELAY_MS);
      const message = `⚠ ${chunk.chunkId}: attempt ${attempt}/${CHUNK_MAX_ATTEMPTS} failed — ${detail}; retrying in ${Math.round(delayMs / 1000)}s`;
      logDebug(message);
      tracker.logWarning(message);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function processChunkOnce(chunk, prepare, tracker, totals) {
  const ndjsonPath = await prepare(chunk);
  logDebug(`${chunk.chunkId}: starting embed`);
  tracker.setChunkEmbedding(chunk.chunkId, true);
  let stats;
  try {
    stats = await embedChunkArticles(chunk.chunkId, ndjsonPath, tracker);
  } finally {
    tracker.setChunkEmbedding(chunk.chunkId, false);
  }
  totals.chunksDone++;
  totals.articles += stats.articles;
  totals.spans += stats.spans;
  totals.unembedded += stats.unembedded;
  totals.alreadyCurrent += stats.alreadyCurrent;
  totals.failedBatches += stats.failedBatches;

  const overallDone = tracker.articlesDone();
  const overallPct = tracker.totalArticles > 0 ? ((overallDone / tracker.totalArticles) * 100).toFixed(1) : '?';
  logDebug(
    `${chunk.chunkId}: done — ${stats.articles} articles, ${stats.spans} spans embedded, ${stats.unembedded} stored unembedded, ${stats.alreadyCurrent} already current` +
      (stats.failedBatches ? `, ${stats.failedBatches} batch(es) FAILED` : '') +
      ` | overall: ${formatCount(overallDone)}/${formatCount(tracker.totalArticles)} articles (${overallPct}%)`
  );
  if (stats.failedBatches === 0) {
    fs.writeFileSync(donePathFor(chunk), JSON.stringify({ completedAt: new Date().toISOString(), totalLines: stats.totalLines }));
  }
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
  await getAccessToken(); // log in up front, so bad credentials fail immediately rather than at the first download
  await ensureSpansTable(); // creates wiki_citation_spans if needed and checks the vector encoding against the live server before any real write
  console.log(`Writing cited spans to ${SPANS_TABLE} (paragraphs${SPAN_OPTIONS.includeListItems ? ' + list items' : ''}${SPAN_OPTIONS.includeTableRows ? ' + table rows' : ''}).`);

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
    const info = await fetchJson(`${API_BASE}/v2/snapshots/${identifier}`, 'POST');
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
        const { contentLength, etag, acceptsRanges } = await headDownload(chunk.url);
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

  const corpusArticles = recordCount;
  if (CHUNK_SHARD) {
    const all = chunks.length;
    chunks = chunks.filter((_, i) => i % CHUNK_SHARD.count === CHUNK_SHARD.index);
    recordCount = recordCount ? Math.round((recordCount * chunks.length) / all) : recordCount;
    console.log(`Shard ${CHUNK_SHARD.index}/${CHUNK_SHARD.count}: ${chunks.length} of ${all} chunks (≈${recordCount ?? '?'} articles).`);
  }
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.contentLength, 0);
  const embed = embedConfig();
  console.log(
    `Total: ${formatGB(totalBytes)} GB across ${chunks.length} chunks. Downloading, extracting, and embedding ` +
      `(${embed.device}, ${embed.dtype}, batches of ≤${embed.batchSize}) ` +
      `${EMBED_CONCURRENCY} chunks at a time (CHUNK_CONCURRENCY), preparing the next ${EMBED_CONCURRENCY} ahead ` +
      `(at most ${EMBED_CONCURRENCY * 2} chunks' worth of raw data on disk)...`
  );
  console.log(
    `Per-chunk stage progress is logged to ${destDir}/debug.log — if the progress bar below stalls, ` +
      `run "tail -f ${destDir}/debug.log" in another terminal to see exactly which chunk and stage it's stuck on.`
  );
  console.log(
    `Embed/Read/Write = ms per article within one embedding chunk (they add up: Art/s ≈ Busy × 1000 / their sum). ` +
      `Busy = chunks embedding / chunk slots — below full means slots are waiting on a download or extraction. ` +
      `Elapsed = active build time over all runs so far (pauses over ${STALL_EXCLUDE_MS / 1000}s are not counted); ` +
      `the line above the table is this session: its elapsed time, what the chunk slots are doing, and the embedding model's state.` +
      (CHUNK_SHARD
        ? ` Sharded run: Progress, Articles and ETA cover the whole corpus across all ${CHUNK_SHARD.count} shards (shared through ${PROGRESS_DIR}; ETA = when the slowest shard finishes); the second line above the table is this shard.`
        : '')
  );
  logDebug(`=== run started: ${chunks.length} chunks, ${formatGB(totalBytes)} GB total ===`);

  const tracker = createProgressDisplay(recordCount, EMBED_CONCURRENCY, CHUNK_SHARD ? { ...CHUNK_SHARD, corpusArticles } : null);
  activeTracker = tracker;
  const avgArticlesPerChunk = recordCount > 0 ? recordCount / chunks.length : 0;
  const totals = { chunksDone: 0, articles: 0, spans: 0, unembedded: 0, alreadyCurrent: 0, failedBatches: 0, failedChunks: [] };

  // Routes DB connection-drop warnings through the table (full redraw, not a
  // bare console.error mid-row) as well as into debug.log for later tailing.
  setConnectionWarningLogger((message) => {
    logDebug(message);
    tracker.logWarning(message);
  });

  // Prefetch: each chunk's download + extraction is started one "round" ahead
  // — when a slot picks up chunk i, chunk i + EMBED_CONCURRENCY (roughly the
  // next one a slot will pick up) starts preparing too. Without this, every
  // slot sat idle for a whole download + extraction between chunks; with it,
  // the next chunk is usually already on disk when a slot frees up. Costs at
  // most one extra chunk on disk per slot. A chunk is only ever prepared once
  // (the promise is shared), and a prefetch that fails is ignored until its
  // chunk is actually reached, where awaiting it surfaces the error as before.
  const preparations = new Map();
  function prepare(chunk) {
    if (!preparations.has(chunk.chunkId)) {
      const preparation = prepareChunk(chunk, tracker);
      preparation.catch(() => {}); // not unhandled while it's only a prefetch; processChunk's await still throws
      preparations.set(chunk.chunkId, preparation);
    }
    return preparations.get(chunk.chunkId);
  }
  function unprepare(chunk) {
    preparations.delete(chunk.chunkId);
  }

  tracker.start();
  await runWithConcurrency(
    chunks,
    (chunk, index) => {
      const upcoming = chunks[index + EMBED_CONCURRENCY];
      if (upcoming && !fs.existsSync(donePathFor(upcoming))) prepare(upcoming);
      return processChunk(chunk, prepare, unprepare, tracker, totals, avgArticlesPerChunk);
    },
    EMBED_CONCURRENCY
  );
  tracker.finish();

  console.log(
    `\nDone. ${chunks.length} chunks total (${totals.chunksDone} newly processed this run): ` +
      `${totals.articles} articles seen, ${totals.spans} spans embedded, ${totals.unembedded} stored unembedded, ${totals.alreadyCurrent} already current.`
  );
  console.log(`Embedded spans are in ${SPANS_TABLE}; cited spans without an online citation (or too short) in ${UNEMBEDDED_TABLE}. Next: build the compact search index (see README).`);
  if (totals.failedChunks.length > 0 || totals.failedBatches > 0) {
    console.log('');
    if (totals.failedChunks.length > 0) {
      console.log(`${totals.failedChunks.length} chunk(s) were set aside after repeated failures:`);
      for (const { chunkId, error } of totals.failedChunks) console.log(`  - ${chunkId}: ${error}`);
    }
    if (totals.failedBatches > 0) {
      console.log(`${totals.failedBatches} batch(es) failed and were skipped (details in ${destDir}/failed-batches.ndjson); their chunks were not marked done.`);
    }
    console.log('Re-run this script to retry them — everything already stored is skipped.');
    process.exitCode = 2;
  }
}

// A long run should survive anything that isn't fatal to the process itself:
// a stray rejection or exception is logged (debug.log + the table) and the
// run continues — each chunk has its own checkpoint and every DB write is
// one transaction, so there's no half-written state to protect by dying.
// SIGTERM (e.g. a port sweep from another tool) is logged so a silent exit
// has an explanation in debug.log.
function survive(kind, reason) {
  const message = `${kind}: ${reason?.stack || reason?.message || reason}`;
  try {
    logDebug(message);
  } catch {
    // no state dir yet
  }
  const oneLine = `⚠ ${message.split('\n')[0]} — continuing`;
  if (activeTracker) activeTracker.logWarning(oneLine);
  else console.error(oneLine);
}
process.on('unhandledRejection', (reason) => survive('unhandled rejection', reason));
process.on('uncaughtException', (error) => survive('uncaught exception', error));
process.on('SIGTERM', () => {
  try {
    logDebug('=== received SIGTERM — exiting; re-run to resume ===');
  } catch {
    // nothing to log to
  }
  process.exit(143);
});

/**
 * A Postgres "disk full" error ("could not extend file ...: No space left on
 * device") is easy to misread as the LOCAL machine running out of space —
 * it isn't. That message comes from the Postgres server itself, writing to
 * its own data directory; for this project that's the remote Railway
 * Postgres volume, a disk entirely separate from wherever this script is
 * running. Confirmed in practice: a crash here happened with 500GB free
 * locally, because the (far smaller) Railway volume was the one that filled.
 */
function isRemoteDiskFullError(error) {
  return /no space left on device/i.test(error.message) || /could not extend file/i.test(error.message);
}

main().catch((error) => {
  console.error(`\nFatal error at ${new Date().toLocaleString()}:`, error.message);
  if (error.detail) console.error(`  ${error.detail}`); // Postgres errors name the offending row/key here
  if (isRemoteDiskFullError(error)) {
    console.error(
      'This looks like the remote Railway Postgres volume is full, not local disk — check/resize it in the Railway ' +
        'dashboard (the volume\'s settings → Live Resize) before re-running.'
    );
  }
  if (error.status === 404 && /^Download failed/.test(error.message)) {
    // The chunk list is cached in snapshot-metadata.json; when Wikimedia
    // regenerates the snapshot, its chunk set changes and old chunk ids 404.
    console.error(
      `Wikimedia most likely regenerated the snapshot since the chunk list was cached, so this chunk no longer exists. ` +
        `Move ${path.join(destDir, 'snapshot-metadata.json')} aside and re-run to fetch the current chunk list.`
    );
  }
  console.error('Re-run this script to resume — completed chunks (marked .done) are skipped, others pick up where they left off.');
  try {
    logDebug(`=== fatal error: ${error.message}${error.detail ? ` (${error.detail})` : ''} ===`);
  } catch {
    // best-effort — don't let a logging failure hide the real error above
  }
  process.exit(1);
});
