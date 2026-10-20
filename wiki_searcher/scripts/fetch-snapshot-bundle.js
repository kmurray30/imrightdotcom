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
 *    If this process dies, a re-run streams the bundle from the start again
 *    (one more GET), skipping everything done or converted.
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
import tar from 'tar-stream';
import { createHash } from 'crypto';
import { loadEnv } from '../../imright/load-env.js';
import { getAccessToken } from '../../utils/wikimediaAuth.js';

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
function say(message) {
  log(message);
  process.stdout.write(`\r\x1b[K${message}\n`);
}
const formatGB = (bytes) => (bytes / 1e9).toFixed(1);

/** The build's state dirs in the working directory (wiki-snapshots-v2, -v2b, …). */
function workerDirs() {
  return fs
    .readdirSync(process.cwd())
    .filter((name) => /^wiki-snapshots-v2[a-z]?$/.test(name))
    .map((name) => path.join(process.cwd(), name))
    .filter((dir) => fs.statSync(dir).isDirectory());
}
/** This unit is already in the archive. */
function spansFileExists(unitId) {
  return fs.existsSync(path.join(spansDir, `${unitId}${SPANS_SUFFIX}`));
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
const stats = { members: 0, converted: 0, archivedDone: 0, convertedArticles: 0, skippedDone: 0, skippedConverted: 0, verified: 0, spansBytes: 0, read: 0 };

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
  stats.spansBytes += fs.statSync(outPath).size;
  return { lines, articles };
}

/** Converts one complete raw unit file and stages its spans file; the raw file is deleted afterwards. */
async function convertRawFile(rawPath, unitId, { stage = true } = {}) {
  const out = path.join(spansDir, `${unitId}${SPANS_SUFFIX}`);
  const { lines, articles } = await convertLines(fs.createReadStream(rawPath), out);
  writeManifest(unitId, { source: `raw chunk file ${path.relative(process.cwd(), rawPath)}`, lines, articles });
  if (stage && unitId.startsWith('bundle_')) await queue.addStagedUnit(unitId, out);
  else if (stage) await queue.stageChunk(unitId, out);
  fs.rmSync(rawPath, { force: true });
  stats.converted++;
  log(`converted ${rawPath} → ${out} (${lines} lines)`);
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
  for (const { full, unitId } of raw) {
    if (spansFileExists(unitId)) {
      fs.rmSync(full, { force: true });
      continue;
    }
    say(`converting raw ${path.relative(process.cwd(), full)} (${(fs.statSync(full).size / 1e9).toFixed(2)} GB) to spans…`);
    await convertRawFile(full, unitId, { stage: !done.has(unitId) }); // a done chunk is archived, not re-embedded
  }
  // Queue rows still pointing at raw files that are gone: stage them again from the bundle.
  const stale = (await queue.stagedRows()).filter((row) => !fs.existsSync(row.staged_path) && !spansFileExists(row.chunk_id)).map((row) => row.chunk_id);
  await queue.unstage(stale);
  if (raw.length || stale.length) say(`local raw files: ${stats.converted} converted, ${raw.length - stats.converted} already archived and removed; ${stale.length} stale staging(s) cleared`);
}

// ---------------------------------------------------------------- the bundle stream
const download = { total: null, offset: 0, fromNetwork: 0, startedAt: Date.now(), failed: null };

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
    if (download.offset > 0) headers.Range = `bytes=${download.offset}-`;
    const controller = new AbortController();
    let stall = null;
    try {
      stall = setTimeout(() => controller.abort(), STALL_MS);
      const response = await fetch(BUNDLE_URL, { headers, signal: controller.signal });
      clearTimeout(stall);
      if (response.status === 429) throw Object.assign(new Error(`Wikimedia refused the bundle download with 429: ${(await response.text()).slice(0, 300)}`), { fatal: true });
      if (response.status !== 200 && response.status !== 206) throw new Error(`GET answered ${response.status} ${response.statusText}`);
      if (download.offset > 0 && response.status !== 206) throw Object.assign(new Error('the server ignored the Range request; stopping rather than restarting the download'), { fatal: true });
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
      say(`⚠ download interrupted at ${formatGB(download.offset)} GB — ${reason}; resuming in ${RETRY_PAUSE_MS / 1000}s`);
      await sleep(RETRY_PAUSE_MS);
    }
  }
}

// ---------------------------------------------------------------- members
let mapping = 'chunks'; // 'chunks' (member n = chunk n) or 'own' (each member its own unit)

async function abandonMapping(reason) {
  mapping = 'own';
  const retired = await queue.supersedeUnstagedChunks(`${identifier}_chunk_`);
  say(`⚠ ${reason}: every member from here on is its own unit of work; ${retired} unstarted snapshot chunk(s) retired in the queue (their articles come from the bundle units)`);
}

async function drain(stream) {
  stream.resume();
  await once(stream, 'end');
}

/** Parse a member straight into a spans file in the archive, and stage it for the embedder unless it is already done. */
async function convertMember(stream, unitId, register, sourceName) {
  const out = path.join(spansDir, `${unitId}${SPANS_SUFFIX}`);
  const { lines, articles } = await convertLines(Readable.from(stream), out);
  writeManifest(unitId, { source: `bundle member ${sourceName}`, lines, articles });
  if (register) await register(unitId, out);
  stats.converted++;
  return { out, lines };
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
      if (spansFileExists(chunkId)) {
        stats.skippedConverted++;
        return drain(stream);
      }
      const out = path.join(spansDir, `${chunkId}${SPANS_SUFFIX}`);
      const { lines, articles } = await convertLines(Readable.from(stream), out);
      if (stats.verified < MAPPING_CHECKS && row.total_lines != null && lines !== row.total_lines) {
        // Members don't line up with chunks: keep this one under its own name and stage it.
        const unitId = `bundle_${name.replace(/\.ndjson$/, '')}`;
        const renamed = path.join(spansDir, `${unitId}${SPANS_SUFFIX}`);
        fs.renameSync(out, renamed);
        writeManifest(unitId, { source: `bundle member ${name}`, lines, articles });
        await abandonMapping(`${name} has ${lines} lines but ${chunkId} had ${row.total_lines}, so members don't map to chunks`);
        await queue.addStagedUnit(unitId, renamed);
        stats.converted++;
        return;
      }
      if (row.total_lines != null && stats.verified < MAPPING_CHECKS) {
        stats.verified++;
        log(`mapping check ${stats.verified}/${MAPPING_CHECKS}: ${name} has ${lines} lines = ${chunkId}`);
      }
      writeManifest(chunkId, { source: `bundle member ${name}`, lines, articles, embeddedBefore: true });
      stats.archivedDone++;
      return;
    } else {
      if (spansFileExists(chunkId)) {
        stats.skippedConverted++;
        return drain(stream);
      }
      const { lines } = await convertMember(stream, chunkId, queue.stageChunk, name);
      log(`converted bundle member ${name} → ${chunkId} (${lines} lines)`);
      return;
    }
  }

  const unitId = `bundle_${name.replace(/\.ndjson$/, '')}`;
  const row = await queue.chunkRow(unitId);
  if (spansFileExists(unitId)) {
    stats.skippedConverted++;
    return drain(stream);
  }
  const { lines } = await convertMember(stream, unitId, row?.done_at ? null : queue.addStagedUnit, name);
  log(`converted bundle member ${name} → ${unitId} (${lines} lines)`);
}

async function streamBundle() {
  const source = Readable.from(bundleBytes());
  const gunzip = zlib.createGunzip();
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    handleMember(header, stream).then(
      () => next(),
      (error) => next(error)
    );
  });
  await new Promise((resolve, reject) => {
    extract.on('finish', resolve);
    for (const s of [source, gunzip, extract]) s.on('error', reject);
    source.pipe(gunzip).pipe(extract);
  });
}

// ---------------------------------------------------------------- main
function statusLine() {
  const elapsed = (Date.now() - download.startedAt) / 1000;
  const rate = elapsed > 0 ? download.fromNetwork / elapsed / 1e6 : 0;
  return (
    `bundle: ${formatGB(download.offset)}/${download.total ? formatGB(download.total) : '?'} GB streamed (${rate.toFixed(1)} MB/s from network, ${loadRequests().gets}/${MAX_REQUESTS} GETs)` +
    ` · members ${stats.members}: ${stats.converted} staged for embedding, ${stats.archivedDone} archived (embedded before), ${stats.skippedConverted} already archived` +
    ` · ${stats.convertedArticles.toLocaleString()} articles parsed · spans on disk ${(stats.spansBytes / 1e6).toFixed(0)} MB`
  );
}

await queue.ensureQueueTable();
await queue.setBundleFetcherState('running'); // bundle-mode workers stay up while this is running
const ticker = setInterval(() => {
  queue.setBundleFetcherState('running').catch(() => {});
  const line = statusLine();
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${line.slice(0, (process.stdout.columns || 200) - 1)}`);
  else log(line);
}, 2_000);

let failure = null;
try {
  say(`Parsed articles are archived in ${spansDir}; log: ${logPath}`);
  await headBundle();
  await convertLocalRawFiles();
  say(`Streaming ${BUNDLE_URL}${fs.existsSync(seedPath) ? ` (first the ${formatGB(fs.statSync(seedPath).size)} GB already saved in ${path.basename(seedPath)})` : ''}…`);
  await streamBundle();
} catch (error) {
  failure = error;
}
clearInterval(ticker);
process.stdout.write('\n');
say(statusLine());
await shutdownSpanWorkers();

if (failure) {
  await queue.setBundleFetcherState('stopped').catch(() => {});
  say(`✗ stopped: ${failure.message}`);
  say('Run this script again to continue: it streams the bundle from the start, skipping everything done or converted.');
  process.exit(1);
}
await queue.setBundleFetcherState('done');
say(`Bundle fully read: ${stats.converted} unit(s) staged for embedding, ${stats.archivedDone} archived only. The archive in ${spansDir} is complete; ${bundleDir} only holds logs now.`);
process.exit(0);
