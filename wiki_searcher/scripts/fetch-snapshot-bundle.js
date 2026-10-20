#!/usr/bin/env node
/**
 * Streams the whole Wikimedia Enterprise snapshot (the one-file bundle,
 * GET /v2/snapshots/{id}/download, ~150 GB compressed for enwiki_namespace_0)
 * and, as it streams, extracts each article's cited spans and writes only
 * those to disk: one small gzipped "spans file" per snapshot chunk (~15–20 MB,
 * versus ~2 GB of raw HTML) in a permanent archive, SPANS_ARCHIVE_DIR
 * (default ./wiki-spans), with a manifest per file. Nothing raw is kept.
 * The archive is the local corpus for any later re-embedding, and every line
 * keeps what a delta refresh needs (page id, revision, date modified, url,
 * event type). The embedding worker (build-index-from-wikimedia.js with
 * CHUNK_SOURCE=bundle) reads files from the archive through the shared chunk
 * queue, in place, and never deletes them.
 *
 * Why the bundle: the free tier allows 1,500 chunk downloads a month but
 * counts the bundle separately (30 a month).
 *
 * Order of work:
 * 1. Raw files already on disk are converted first, then deleted: extracted
 *    chunks left in the wiki-snapshots-v2* dirs (their .progress checkpoints
 *    stay valid: spans files have one line per raw line) and raw members a
 *    previous version of this script staged. Partial chunk downloads
 *    (.tar.gz) can't be read and are deleted; the bundle covers them.
 * 2. The bundle is streamed: network → gunzip → tar → parse → spans files.
 *    Bytes a previous version saved to <bundleDir>/<id>.tar.gz are read
 *    first and the download continues after them (that file is then
 *    deleted). A dropped connection resumes with a Range request into the
 *    same stream. Every GET is counted in <bundleDir>/requests.json and
 *    capped by BUNDLE_MAX_REQUESTS (default 12); a 429 stops it.
 *    Every member is archived. Members of chunks the embedder hasn't done
 *    are also staged for it; members of chunks already embedded are only
 *    archived (the stream is one pass, so they come in snapshot order, at no
 *    extra download). Members already in the archive are skipped.
 *    Stopping is safe at any time (Ctrl-C, a crash, a reboot): as each member
 *    begins, <bundleDir>/resume.json records a decompressor access point
 *    (resumableGunzip.js) at or before it, so a re-run downloads from there
 *    (one more GET) and repeats at most the member it was in.
 *
 * Usage: node wiki_searcher/scripts/fetch-snapshot-bundle.js [bundleDir]   (default ./wiki-bundle)
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import { once } from 'events';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { loadEnv } from '../../imright/load-env.js';
import { getAccessToken } from '../../utils/wikimediaAuth.js';
import { createPanel, color, bar, fit, formatBytes, formatCount, formatDuration } from '../fetcherDisplay.js';
import { ResumableGunzip, serializePoint, deserializePoint } from '../resumableGunzip.js';
import { TarWalker } from '../tarWalker.js';

loadEnv();
process.env.DB_IDLE_TIMEOUT_MS ??= '0'; // keep connections open (see build-index-from-wikimedia.js)
process.env.EXTRACT_WORKERS ??= process.env.PARSE_WORKERS || '6'; // HTML parsing threads (spanWorkerPool.js)
const queue = await import('../chunkQueue.js');
const { SPAN_OPTIONS } = await import('../embeddingIndex.js');
const { extractSpansParallel, shutdownSpanWorkers } = await import('../spanWorkerPool.js');

const API_BASE = 'https://api.enterprise.wikimedia.com';
const identifier = process.env.SNAPSHOT_ID || 'enwiki_namespace_0';
const BUNDLE_URL = process.env.BUNDLE_URL || `${API_BASE}/v2/snapshots/${identifier}/download`;
const bundleDir = path.resolve(process.argv[2] || './wiki-bundle');
const seedPath = path.join(bundleDir, `${identifier}.tar.gz`); // raw bytes saved by the previous version of this script
const oldMembersDir = path.join(bundleDir, 'members'); // raw members staged by the previous version
const spansDir = path.resolve(process.env.SPANS_ARCHIVE_DIR || './wiki-spans'); // permanent archive of parsed articles
const requestsPath = path.join(bundleDir, 'requests.json');
const resumePath = path.join(bundleDir, 'resume.json'); // where to pick the stream up again after a stop
const logPath = path.join(bundleDir, 'fetch.log');
const MAX_REQUESTS = Number(process.env.BUNDLE_MAX_REQUESTS) || 12;
const STALL_MS = 120_000;
const RETRY_PAUSE_MS = Number(process.env.BUNDLE_RETRY_PAUSE_MS) || 30_000;
const PARSE_BATCH = 200;
const MAPPING_CHECKS = 3; // done chunks whose line counts must match before members are mapped to chunks without parsing
const SPANS_SUFFIX = '.spans.ndjson.gz';
const UNIT_FILE = new RegExp(`^(${identifier}_chunk_\\d+|bundle_.+)\\.ndjson$`);

fs.mkdirSync(spansDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(message) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}
/** An event line: printed above the live panel (and to the log). */
function say(message) {
  log(message.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  panel.event(message);
}
/** "chunk 171" for enwiki_namespace_0_chunk_171; bundle units keep their name. */
const unitLabel = (unitId) => {
  const n = /_chunk_(\d+)$/.exec(unitId)?.[1];
  return n === undefined ? unitId : `chunk ${n}`;
};
const formatGB = (bytes) => (bytes / 1e9).toFixed(1);
const shortPath = (p) => path.relative(process.cwd(), p) || '.';

/** The build's state dirs in the working directory (wiki-snapshots-v2, -v2b, …). */
function workerDirs() {
  return fs
    .readdirSync(process.cwd())
    .filter((name) => /^wiki-snapshots-v2[a-z]?$/.test(name))
    .map((name) => path.join(process.cwd(), name))
    .filter((dir) => fs.statSync(dir).isDirectory());
}
/** This unit is already in the archive (its manifest is written last, so a unit cut off by a stop doesn't count). */
function spansFileExists(unitId) {
  return fs.existsSync(path.join(spansDir, `${unitId}${SPANS_SUFFIX}`)) && fs.existsSync(path.join(spansDir, `${unitId}.manifest.json`));
}

/** Where the archived articles came from: written beside each spans file, for re-embedding and delta refreshes later. */
const snapshotInfo = { identifier, etag: null, lastModified: null, bundleUrl: BUNDLE_URL };
const parserVersion = (() => {
  const hash = createHash('sha1');
  for (const file of ['../spanExtractor.js', '../embeddingIndex.js']) {
    try {
      hash.update(fs.readFileSync(new URL(file, import.meta.url)));
    } catch {
      hash.update(file);
    }
  }
  return hash.digest('hex').slice(0, 12);
})();
function writeManifest(unitId, details) {
  fs.writeFileSync(
    path.join(spansDir, `${unitId}.manifest.json`),
    JSON.stringify({ unit: unitId, snapshot: snapshotInfo, parserVersion, spanOptions: SPAN_OPTIONS, createdAt: new Date().toISOString(), ...details }, null, 2)
  );
}

// ---------------------------------------------------------------- parsing
const stats = { members: 0, converted: 0, memberStaged: 0, archivedDone: 0, convertedArticles: 0, skippedConverted: 0, verified: 0, spansBytes: 0 };
/** What the live panel shows besides `stats` and `download`. */
const ui = {
  phase: 'starting', // starting → converting → streaming → done | stopped
  rawDone: false, // step 1 finished
  raw: { total: 0, done: 0, converted: 0 }, // step 1
  current: null, // { verb, label, note, parsing } — the unit being worked on
  currentArticles: 0,
  expectedMembers: null, // snapshot chunks in the queue (one bundle member each)
  embedder: null, // queue.embedderOverview()
  archiveAtStart: { files: 0, bytes: 0 },
  retryAt: null, // download dropped: retrying at this time
};

/**
 * Raw NDJSON lines (one article per line) → spans file: one output line per
 * input line, so line numbers (and checkpoints) carry over. Returns the line count.
 */
async function convertLines(lineStream, outPath) {
  const part = `${outPath}.part`;
  const gzip = zlib.createGzip({ level: 6 });
  const file = fs.createWriteStream(part);
  let writeError = null;
  for (const s of [gzip, file]) s.on('error', (error) => (writeError = error));
  gzip.pipe(file);
  const write = async (text) => {
    if (writeError) throw writeError;
    if (!gzip.write(text)) await once(gzip, 'drain');
  };

  const rl = readline.createInterface({ input: lineStream, crlfDelay: Infinity });
  let lines = 0;
  let articles = 0;
  let batch = [];
  ui.currentArticles = 0;
  async function flush() {
    if (batch.length === 0) return;
    const records = batch.map((line) => {
      if (!line.trim()) return null;
      try {
        const article = JSON.parse(line);
        if (!article?.article_body?.html) return null;
        return {
          title: article.name,
          pageId: article.identifier ?? null,
          versionIdentifier: article.version?.identifier ?? null,
          dateModified: article.date_modified ?? null,
          url: article.url ?? null,
          event: article.event?.type ?? null,
          html: article.article_body.html,
        };
      } catch {
        return null;
      }
    });
    const toParse = records.filter(Boolean);
    const results = await extractSpansParallel(toParse.map((r) => ({ title: r.title, html: r.html })), SPAN_OPTIONS);
    let j = 0;
    let out = '';
    for (const record of records) {
      if (!record) {
        out += 'null\n';
        continue;
      }
      const result = results[j++];
      const { html, ...meta } = record;
      out += JSON.stringify(result.error ? { ...meta, error: result.error } : { ...meta, spans: result.spans, unembedded: result.unembedded }) + '\n';
    }
    stats.convertedArticles += toParse.length;
    ui.currentArticles += toParse.length;
    articles += toParse.length;
    await write(out);
    batch = [];
  }
  for await (const line of rl) {
    lines++;
    batch.push(line);
    if (batch.length >= PARSE_BATCH) await flush();
  }
  await flush();
  gzip.end();
  await once(file, 'finish');
  if (writeError) throw writeError;
  fs.renameSync(part, outPath);
  const bytes = fs.statSync(outPath).size;
  stats.spansBytes += bytes;
  return { lines, articles, bytes };
}

/** Converts one complete raw unit file and stages its spans file; the raw file is deleted afterwards. */
async function convertRawFile(rawPath, unitId, { stage = true } = {}) {
  const out = path.join(spansDir, `${unitId}${SPANS_SUFFIX}`);
  const { lines, articles, bytes } = await convertLines(fs.createReadStream(rawPath), out);
  writeManifest(unitId, { source: `raw chunk file ${path.relative(process.cwd(), rawPath)}`, lines, articles });
  if (stage && unitId.startsWith('bundle_')) await queue.addStagedUnit(unitId, out);
  else if (stage) await queue.stageChunk(unitId, out);
  fs.rmSync(rawPath, { force: true });
  stats.converted++;
  ui.raw.converted++;
  log(`converted ${rawPath} → ${out} (${lines} lines)`);
  say(`${stage ? color.green('✓') : color.blue('✓')} ${color.bold(unitLabel(unitId))} ${stage ? color.green('sent to the embedder') : color.blue('kept for later (already embedded)')} · converted from a leftover raw file · ${formatCount(articles)} articles, ${formatBytes(bytes)} ${color.gray('(raw file deleted)')}`);
}

/** Step 1: raw files already on disk → spans files; raw deleted. */
async function convertLocalRawFiles() {
  const done = await queue.doneChunkIds();
  const raw = [];
  for (const dir of [...workerDirs(), oldMembersDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith('.ndjson.part')) {
        fs.rmSync(full, { force: true }); // an unfinished raw member
        continue;
      }
      if (/\.tar\.gz(\.etag)?$/.test(name) && dir !== bundleDir) {
        fs.rmSync(full, { force: true }); // a partial chunk download: unreadable, the bundle covers it
        log(`deleted partial chunk download ${full}`);
        continue;
      }
      const unitId = UNIT_FILE.exec(name)?.[1];
      if (unitId) raw.push({ full, unitId });
    }
  }
  ui.raw.total = raw.length;
  for (const { full, unitId } of raw) {
    if (spansFileExists(unitId)) {
      fs.rmSync(full, { force: true });
      ui.raw.done++;
      continue;
    }
    ui.current = { verb: 'Converting', label: unitLabel(unitId), note: `raw file in ${path.relative(process.cwd(), path.dirname(full))}/ (${formatBytes(fs.statSync(full).size)})`, parsing: true };
    await convertRawFile(full, unitId, { stage: !done.has(unitId) }); // a done chunk is archived, not re-embedded
    ui.raw.done++;
  }
  ui.current = null;
  // Queue rows still pointing at raw files that are gone: stage them again from the bundle.
  const stale = (await queue.stagedRows()).filter((row) => !fs.existsSync(row.staged_path) && !spansFileExists(row.chunk_id)).map((row) => row.chunk_id);
  await queue.unstage(stale);
  // Archived units that are neither done nor staged (a stop between saving and staging): hand them over.
  const staged = new Set((await queue.stagedRows()).map((row) => row.chunk_id));
  const doneNow = await queue.doneChunkIds();
  let handed = 0;
  for (const name of fs.readdirSync(spansDir)) {
    if (!name.endsWith(SPANS_SUFFIX)) continue;
    const unitId = name.slice(0, -SPANS_SUFFIX.length);
    if (doneNow.has(unitId) || staged.has(unitId) || !spansFileExists(unitId)) continue;
    const file = path.join(spansDir, name);
    if (unitId.startsWith('bundle_')) await queue.addStagedUnit(unitId, file);
    else if ((await queue.chunkRow(unitId)) == null) continue;
    else await queue.stageChunk(unitId, file);
    handed++;
  }
  if (handed) say(`${handed} chunk(s) on disk sent to the embedder (a stop had cut them off before the hand-over)`);
  if (raw.length) say(`Leftover raw files: ${ui.raw.converted} converted, ${raw.length - ui.raw.converted} were already converted (raw copy deleted)`);
  else say(color.gray('No leftover raw chunk files on disk (earlier runs already converted them)'));
  if (stale.length) log(`${stale.length} stale hand-over(s) cleared`);
}

// ---------------------------------------------------------------- the bundle stream
const download = { total: null, offset: 0, fromNetwork: 0, seedBytes: 0, startedAt: Date.now() };

function loadRequests() {
  try {
    return JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  } catch {
    return { gets: 0, etag: null, history: [] };
  }
}
function countGet(fromByte) {
  const requests = loadRequests();
  if (requests.gets >= MAX_REQUESTS) {
    throw new Error(`request cap reached (${requests.gets} GETs, BUNDLE_MAX_REQUESTS=${MAX_REQUESTS}); each may count against the 30 snapshot downloads a month. Raise the cap to continue.`);
  }
  requests.gets++;
  requests.history.push({ at: new Date().toISOString(), fromByte });
  fs.writeFileSync(requestsPath, JSON.stringify(requests, null, 2));
}

/** The bundle's bytes, in order: saved seed bytes first, then the network (resuming on drops). Nothing is written to disk. */
async function headBundle() {
  const head = await fetch(BUNDLE_URL, { method: 'HEAD', headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  if (!head.ok) throw new Error(`HEAD answered ${head.status} ${head.statusText}`);
  download.total = Number(head.headers.get('content-length'));
  snapshotInfo.etag = head.headers.get('etag');
  snapshotInfo.lastModified = head.headers.get('last-modified');
  fs.writeFileSync(path.join(spansDir, 'ARCHIVE.json'), JSON.stringify({ snapshot: snapshotInfo, parserVersion, spanOptions: SPAN_OPTIONS, updatedAt: new Date().toISOString(), format: 'one JSON line per raw snapshot line: null, or {title, pageId, versionIdentifier, dateModified, url, event, spans, unembedded} / {…, error}' }, null, 2));
}

async function* bundleBytes() {
  const etag = snapshotInfo.etag;
  const requests = loadRequests();
  if (fs.existsSync(seedPath) && requests.etag && etag && requests.etag !== etag) {
    say(`the snapshot changed since ${path.basename(seedPath)} was saved (ETag ${requests.etag} → ${etag}); not using it`);
    fs.rmSync(seedPath, { force: true });
  }
  fs.writeFileSync(requestsPath, JSON.stringify({ ...requests, etag }, null, 2));

  if (fs.existsSync(seedPath)) {
    download.seedBytes = fs.statSync(seedPath).size;
    const handle = await fsp.open(seedPath, 'r');
    const buffer = Buffer.allocUnsafe(4 << 20);
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, download.offset);
        if (bytesRead === 0) break;
        download.offset += bytesRead;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    log(`read ${download.offset} saved bytes from ${seedPath}; deleting it and continuing from the network`);
    fs.rmSync(seedPath, { force: true });
  }

  while (download.offset < download.total) {
    countGet(download.offset);
    const headers = { Authorization: `Bearer ${await getAccessToken()}` };
    if (download.offset > 0) {
      headers.Range = `bytes=${download.offset}-`;
      if (snapshotInfo.etag) headers['If-Range'] = snapshotInfo.etag; // a changed snapshot answers 200 (whole file) instead of the wrong bytes
    }
    const controller = new AbortController();
    let stall = null;
    try {
      stall = setTimeout(() => controller.abort(), STALL_MS);
      const response = await fetch(BUNDLE_URL, { headers, signal: controller.signal });
      clearTimeout(stall);
      if (response.status === 429) throw Object.assign(new Error(`Wikimedia refused the bundle download with 429: ${(await response.text()).slice(0, 300)}`), { fatal: true });
      if (response.status !== 200 && response.status !== 206) throw new Error(`GET answered ${response.status} ${response.statusText}`);
      if (download.offset > 0 && response.status !== 206) throw Object.assign(new Error('the server ignored the Range request; stopping rather than restarting the download'), { fatal: true });
      ui.retryAt = null;
      const reader = response.body.getReader();
      for (;;) {
        // Only time spent waiting on the network counts as a stall, not time the parser takes.
        stall = setTimeout(() => controller.abort(), STALL_MS);
        const { done, value } = await reader.read();
        clearTimeout(stall);
        if (done) break;
        download.offset += value.length;
        download.fromNetwork += value.length;
        yield Buffer.from(value);
      }
    } catch (error) {
      clearTimeout(stall);
      if (error.fatal || /request cap/.test(error.message)) throw error;
      const reason = error.name === 'AbortError' ? `no data for ${STALL_MS / 1000}s` : error.message || error.code;
      say(`${color.yellow('!')} ${color.yellow(`Connection dropped at ${formatGB(download.offset)} GB`)} (${reason}). Reconnecting in ${RETRY_PAUSE_MS / 1000}s; nothing is lost.`);
      ui.retryAt = Date.now() + RETRY_PAUSE_MS;
      await sleep(RETRY_PAUSE_MS);
    }
  }
}

// ---------------------------------------------------------------- members
let mapping = 'chunks'; // 'chunks' (member n = chunk n) or 'own' (each member its own unit)

async function abandonMapping(reason) {
  mapping = 'own';
  const retired = await queue.supersedeUnstagedChunks(`${identifier}_chunk_`);
  say(`${color.yellow('!')} ${reason}: every member from here on is its own unit of work; ${retired} unstarted snapshot chunk(s) retired in the queue (their articles come from the bundle units)`);
}

async function drain(stream) {
  stream.resume();
  await once(stream, 'end');
}

/** A member whose spans file is already in the archive: its bytes still have to stream past. */
async function skipMember(stream, unitId) {
  stats.skippedConverted++;
  ui.current = { verb: 'Skipping', label: unitLabel(unitId), note: 'already saved (its bytes still stream past)' };
  await drain(stream);
  ui.current = null;
  say(color.gray(`– ${unitLabel(unitId)} skipped (done on an earlier run)`));
}

/** Parse a member straight into a spans file in the archive, and stage it for the embedder unless it is already done. */
async function convertMember(stream, unitId, register, sourceName) {
  const out = path.join(spansDir, `${unitId}${SPANS_SUFFIX}`);
  ui.current = { verb: 'Parsing', label: unitLabel(unitId), note: register ? 'new, for the embedder' : 'already embedded, keeping it for later', parsing: true };
  const { lines, articles, bytes } = await convertLines(Readable.from(stream), out);
  ui.current = null;
  writeManifest(unitId, { source: `bundle member ${sourceName}`, lines, articles, ...(register ? {} : { embeddedBefore: true }) });
  if (register) {
    await register(unitId, out);
    stats.converted++;
    stats.memberStaged++;
    say(`${color.green('✓')} ${color.bold(unitLabel(unitId))} ${color.green('sent to the embedder')} · ${formatCount(articles)} articles, ${formatBytes(bytes)}`);
  } else {
    stats.archivedDone++;
    say(`${color.blue('✓')} ${color.bold(unitLabel(unitId))} ${color.blue('kept for later (already embedded)')} · ${formatCount(articles)} articles, ${formatBytes(bytes)}`);
  }
  return { out, lines, articles };
}

async function handleMember(header, stream) {
  const name = path.basename(header.name);
  if (header.type !== 'file' || !name.endsWith('.ndjson')) return drain(stream);
  stats.members++;
  const number = /_(\d+)\.ndjson$/.exec(name)?.[1];

  if (mapping === 'chunks' && number !== undefined) {
    const chunkId = `${identifier}_chunk_${number}`;
    const row = await queue.chunkRow(chunkId);
    if (!row) {
      await abandonMapping(`${name} maps to ${chunkId}, which the chunk queue doesn't know`);
    } else if (row.done_at) {
      // Already embedded: archived only (for later), not staged.
      if (spansFileExists(chunkId)) return skipMember(stream, chunkId);
      if (stats.verified < MAPPING_CHECKS && row.total_lines != null) {
        // Check that members line up with chunks before trusting the mapping.
        const out = path.join(spansDir, `${chunkId}${SPANS_SUFFIX}`);
        ui.current = { verb: 'Parsing', label: unitLabel(chunkId), note: `already embedded, keeping it for later (mapping check ${stats.verified + 1}/${MAPPING_CHECKS})`, parsing: true };
        const { lines, articles, bytes } = await convertLines(Readable.from(stream), out);
        ui.current = null;
        if (lines !== row.total_lines) {
          // Members don't line up with chunks: keep this one under its own name and stage it.
          const unitId = `bundle_${name.replace(/\.ndjson$/, '')}`;
          const renamed = path.join(spansDir, `${unitId}${SPANS_SUFFIX}`);
          fs.renameSync(out, renamed);
          writeManifest(unitId, { source: `bundle member ${name}`, lines, articles });
          await abandonMapping(`${name} has ${lines} lines but ${chunkId} had ${row.total_lines}, so members don't map to chunks`);
          await queue.addStagedUnit(unitId, renamed);
          stats.converted++;
          stats.memberStaged++;
          return;
        }
        stats.verified++;
        log(`mapping check ${stats.verified}/${MAPPING_CHECKS}: ${name} has ${lines} lines = ${chunkId}`);
        writeManifest(chunkId, { source: `bundle member ${name}`, lines, articles, embeddedBefore: true });
        stats.archivedDone++;
        say(`${color.blue('✓')} ${color.bold(unitLabel(chunkId))} ${color.blue('kept for later (already embedded)')} · ${formatCount(articles)} articles, ${formatBytes(bytes)}`);
        return;
      }
      await convertMember(stream, chunkId, null, name);
      return;
    } else {
      if (spansFileExists(chunkId)) return skipMember(stream, chunkId);
      const { lines } = await convertMember(stream, chunkId, queue.stageChunk, name);
      log(`converted bundle member ${name} → ${chunkId} (${lines} lines)`);
      return;
    }
  }

  const unitId = `bundle_${name.replace(/\.ndjson$/, '')}`;
  const row = await queue.chunkRow(unitId);
  if (spansFileExists(unitId)) return skipMember(stream, unitId);
  const { lines } = await convertMember(stream, unitId, row?.done_at ? null : queue.addStagedUnit, name);
  log(`converted bundle member ${name} → ${unitId} (${lines} lines)`);
}

// ---------------------------------------------------------------- stop and resume
/**
 * Where to resume: saved as each bundle member begins (every earlier member
 * is then fully archived). It holds a decompressor access point at or before
 * the member's first byte, so a re-run downloads from there instead of from
 * the start of the bundle and repeats at most the member it was in.
 */
function loadResumePoint() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
  } catch {
    return null;
  }
  if (saved.etag !== snapshotInfo.etag) {
    say(`${color.yellow('!')} The snapshot changed since the last run (ETag ${saved.etag} → ${snapshotInfo.etag}), so it can't resume mid-file; streaming the new one from the start (chunks already saved are still skipped)`);
    return null;
  }
  return saved;
}
function saveResumePoint(fields) {
  const tmp = `${resumePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ etag: snapshotInfo.etag, savedAt: new Date().toISOString(), ...fields }));
  fs.renameSync(tmp, resumePath);
}
function countsToSave() {
  return { members: stats.members, memberStaged: stats.memberStaged, archivedDone: stats.archivedDone, skippedConverted: stats.skippedConverted, verified: stats.verified, mapping };
}

async function streamBundle(resume) {
  const gunzip = new ResumableGunzip(resume ? deserializePoint(resume.point) : null);
  download.offset = gunzip.startOffset;
  const walker = new TarWalker({
    offset: resume ? resume.point.out : 0,
    skipTo: resume ? resume.entryOffset : 0,
    onEntryStart: (entryOffset) => {
      if (gunzip.point) saveResumePoint({ point: serializePoint(gunzip.point), entryOffset, compressedOffset: gunzip.point.in, ...countsToSave() });
    },
    onEntry: handleMember,
  });
  for await (const chunk of bundleBytes()) {
    for (const piece of gunzip.push(chunk)) await walker.write(piece);
    if (walker.ended) break;
  }
  if (!walker.complete) throw new Error(`the bundle ended in the middle of a member (at uncompressed byte ${walker.offset})`);
  saveResumePoint({ complete: true, ...countsToSave() });
}

// ---------------------------------------------------------------- main
/** One line for the log (and for output that isn't a terminal). */
function statusLine() {
  return (
    `bundle: ${formatGB(download.offset)}/${download.total ? formatGB(download.total) : '?'} GB streamed (${streamRate().toFixed(1)} MB/s, ${loadRequests().gets}/${MAX_REQUESTS} GETs)` +
    ` · members ${stats.members}: ${stats.memberStaged} staged for embedding, ${stats.archivedDone} archived (embedded before), ${stats.skippedConverted} already archived` +
    ` · ${stats.convertedArticles.toLocaleString()} articles parsed · spans written this run ${(stats.spansBytes / 1e6).toFixed(0)} MB`
  );
}

// Stream speed over the last minute (bundle bytes through the parser, saved or downloaded).
const rateSamples = [];
function sampleRate() {
  const now = Date.now();
  rateSamples.push({ at: now, offset: download.offset });
  while (rateSamples.length > 2 && now - rateSamples[0].at > 60_000) rateSamples.shift();
}
function streamRate() {
  if (rateSamples.length < 2) return 0;
  const first = rateSamples[0];
  const last = rateSamples[rateSamples.length - 1];
  return last.at > first.at ? (last.offset - first.offset) / ((last.at - first.at) / 1000) / 1e6 : 0;
}

function renderPanel(width) {
  const { bold, gray, green, yellow, red, cyan, blue, magenta } = color;
  const indent = ' '.repeat(13);
  const barWidth = Math.max(10, Math.min(36, width - 40));
  const lines = [''];

  // Progress: chunks of the bundle read, and the download behind it.
  const total = Math.max(ui.expectedMembers || 0, stats.members) || 1;
  const percent = ui.phase === 'done' ? 100 : Math.floor((stats.members / total) * 100);
  lines.push(
    `  ${bold('Progress')}   ${bar(barWidth, [
      { fraction: stats.memberStaged / total, paint: green },
      { fraction: stats.archivedDone / total, paint: blue },
      { fraction: stats.skippedConverted / total, paint: magenta },
    ])}  ${bold(`${percent}%`)}  ${gray(`${stats.members} of ${ui.expectedMembers ?? '?'} chunks`)}`
  );
  if (download.total) {
    const rate = streamRate();
    let detail = `${formatGB(download.offset)} of ${formatGB(download.total)} GB`;
    if (ui.retryAt) detail += ` · ${yellow(`connection dropped, reconnecting in ${Math.max(0, Math.ceil((ui.retryAt - Date.now()) / 1000))}s`)}`;
    else if (ui.phase === 'done') detail += ' · finished';
    else if (ui.phase !== 'streaming') detail += gray(' · starts after the leftover files');
    else if (download.fromNetwork === 0 && download.seedBytes > 0 && download.offset < download.seedBytes) detail += ` · reading the ${formatBytes(download.seedBytes)} downloaded on an earlier run (no internet needed)`;
    else if (rate > 0) detail += ` · ${rate.toFixed(1)} MB/s · ${bold(`about ${formatDuration(((download.total - download.offset) / (rate * 1e6)) * 1000)} left`)}`;
    else detail += gray(' · measuring speed…');
    lines.push(`${indent}${detail}`);
    const gets = loadRequests().gets;
    if (gets >= MAX_REQUESTS - 3) lines.push(`${indent}${yellow(`! ${gets} of ${MAX_REQUESTS} downloads used (BUNDLE_MAX_REQUESTS)`)}`);
  }
  lines.push('');

  // What it's doing right now.
  let now;
  if (ui.current) {
    now = `${ui.current.verb} ${cyan(bold(ui.current.label))}${ui.current.parsing ? ` (${formatCount(ui.currentArticles)} articles so far)` : ''} ${gray(`· ${ui.current.note}`)}`;
    if (ui.phase === 'converting' && ui.raw.total) now += gray(` · leftover ${ui.raw.done + 1} of ${ui.raw.total}`);
  } else {
    now = gray({ starting: 'starting up…', converting: 'looking for leftover raw files…', streaming: 'downloading the next chunk…', done: 'nothing, all done', stopped: 'nothing, stopped' }[ui.phase]);
  }
  lines.push(`  ${bold('Now')}        ${now}`);
  lines.push('');

  // Where the chunks went.
  lines.push(`  ${bold('Chunks')}     ${green('■')} ${bold(String(stats.memberStaged).padStart(3))}  new, sent to the embedder`);
  lines.push(`${indent}${blue('■')} ${bold(String(stats.archivedDone).padStart(3))}  already embedded, only kept on disk for later`);
  lines.push(`${indent}${magenta('■')} ${bold(String(stats.skippedConverted).padStart(3))}  done on an earlier run, skipped`);
  if (ui.raw.converted) lines.push(`${indent}${gray(`+ ${ui.raw.converted} leftover raw file(s) converted at the start`)}`);
  lines.push('');

  // Is the embedder fed?
  const e = ui.embedder;
  let embedder;
  if (!e) embedder = gray('checking…');
  else if (e.left === 0) embedder = green('● everything is embedded');
  else {
    const queued = e.waiting > 0 ? green(`● ${e.waiting} ${e.waiting === 1 ? 'chunk' : 'chunks'} queued up for it`) : yellow('● nothing queued up for it right now');
    embedder = `${queued} ${gray(`· ${e.done} of ${e.done + e.left} chunks embedded`)}`;
  }
  lines.push(`  ${bold('Embedder')}   ${embedder}`);

  // The archive on disk.
  const files = ui.archiveAtStart.files + stats.converted + stats.archivedDone;
  lines.push(`  ${bold('On disk')}    ${formatCount(files)} chunks, ${formatBytes(ui.archiveAtStart.bytes + stats.spansBytes)} in ${shortPath(spansDir)}/`);
  lines.push('');

  const footer = {
    done: 'All done: every chunk is in the archive.',
    stopped: 'Stopped. Run it again to continue from this chunk.',
  }[ui.phase] ?? 'Safe to Ctrl-C: next time it picks up from the chunk it is on.';
  lines.push(gray(`  ${footer}`));
  lines.push(gray(`  Details: ${shortPath(logPath)}`));

  const phaseLabel = {
    starting: cyan('starting'),
    converting: cyan('converting leftovers'),
    streaming: cyan('downloading + parsing'),
    done: green('done'),
    stopped: red('stopped'),
  }[ui.phase];
  return { title: 'Wikipedia fetcher', right: `${phaseLabel} ${gray(`· ${formatDuration(Date.now() - download.startedAt)}`)}`, lines };
}

const panel = createPanel(renderPanel);

// What's already in the archive (for the panel's running total).
for (const name of fs.readdirSync(spansDir)) {
  if (!name.endsWith(SPANS_SUFFIX)) continue;
  ui.archiveAtStart.files++;
  ui.archiveAtStart.bytes += fs.statSync(path.join(spansDir, name)).size;
}

await queue.ensureQueueTable();
await queue.setBundleFetcherState('running'); // bundle-mode workers stay up while this is running
ui.expectedMembers = (await queue.queueSnapshot().catch(() => null))?.chunks ?? null;
const refreshEmbedder = () => queue.embedderOverview().then((overview) => (ui.embedder = overview), () => {});
await refreshEmbedder();
let ticks = 0;
const ticker = setInterval(() => {
  ticks++;
  sampleRate();
  panel.draw();
  if (ticks % 2 === 0) queue.setBundleFetcherState('running').catch(() => {});
  if (ticks % 5 === 0) refreshEmbedder();
  if (ticks % 60 === 0) log(statusLine());
}, 1_000);

let failure = null;
try {
  say(`Starting. ${formatCount(ui.archiveAtStart.files)} chunks already on disk in ${shortPath(spansDir)}/`);
  await headBundle();
  ui.phase = 'converting';
  panel.draw();
  await convertLocalRawFiles();
  ui.rawDone = true;
  ui.phase = 'streaming';
  const resume = loadResumePoint();
  if (resume) {
    Object.assign(stats, { members: resume.members, memberStaged: resume.memberStaged, archivedDone: resume.archivedDone, skippedConverted: resume.skippedConverted, verified: resume.verified });
    mapping = resume.mapping;
  }
  if (resume?.complete) {
    download.offset = download.total;
    say('This snapshot was already fully read on an earlier run; nothing left to download');
  } else {
    if (resume) {
      say(`${color.green('Resuming')} at ${formatGB(resume.compressedOffset)} of ${formatGB(download.total)} GB, from the start of the chunk it was on (${stats.members} chunks already done)`);
      if (fs.existsSync(seedPath) && fs.statSync(seedPath).size <= resume.compressedOffset) fs.rmSync(seedPath, { force: true }); // already past it
    } else {
      say(`Downloading + parsing the ${formatGB(download.total)} GB snapshot${fs.existsSync(seedPath) ? `, starting with the ${formatGB(fs.statSync(seedPath).size)} GB downloaded on an earlier run` : ''}…`);
    }
    await streamBundle(resume);
  }
} catch (error) {
  failure = error;
}
clearInterval(ticker);
ui.current = null;
ui.retryAt = null;
ui.phase = failure ? 'stopped' : 'done';
await refreshEmbedder();
log(statusLine());
await shutdownSpanWorkers();

if (failure) {
  await queue.setBundleFetcherState('stopped').catch(() => {});
  say(`${color.red('✗ Stopped:')} ${failure.message}`);
  say('Run this script again to continue: it picks up at the start of the chunk it was on.');
  panel.close();
  process.exit(1);
}
await queue.setBundleFetcherState('done');
say(`${color.green('✓ Done:')} ${stats.memberStaged} chunk(s) sent to the embedder, ${stats.archivedDone} kept for later. The archive in ${shortPath(spansDir)}/ is complete; ${shortPath(bundleDir)}/ only holds logs now.`);
panel.close();
process.exit(0);
