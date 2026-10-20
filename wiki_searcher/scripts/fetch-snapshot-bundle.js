#!/usr/bin/env node
/**
 * Downloads the whole Wikimedia Enterprise snapshot as ONE file (the bundle,
 * GET /v2/snapshots/{id}/download, ~150 GB for enwiki_namespace_0) and, while
 * it downloads, splits it into its per-chunk NDJSON files and hands them to
 * the build workers through the shared chunk queue.
 *
 * Why: the free tier allows 1,500 chunk downloads a month but counts a full
 * bundle download separately (30 a month). When the chunk allowance runs
 * out, the bundle still gets everything with a handful of requests. Run it
 * beside the workers, which then take staged chunks instead of downloading
 * (CHUNK_SOURCE=bundle in build-index-from-wikimedia.js).
 *
 * - Download: one streaming GET; a dropped connection resumes with a Range
 *   request. Every GET is counted in <bundleDir>/requests.json (each may
 *   count against the monthly allowance) and BUNDLE_MAX_REQUESTS (default 8)
 *   is a hard cap. A 429 stops it at once, with Wikimedia's answer printed.
 * - Split: the growing file is read from the start → gunzip → tar. Each
 *   .ndjson member is written to <bundleDir>/members/ and registered in the
 *   queue. At most BUNDLE_STAGE_MAX (default 12) members wait on disk for a
 *   worker; past that, reading pauses (the download carries on).
 * - Members map to snapshot chunks by number (…_<n>.ndjson → …_chunk_<n>).
 *   That mapping is checked against chunks already done (same line count)
 *   before it is relied on; if it doesn't hold, every member becomes its own
 *   unit of work instead (already-stored articles are skipped cheaply).
 *   Members of done chunks, and of chunks a worker already has extracted
 *   locally, are skipped.
 * - Restart-safe: re-reads the bundle from the start, skipping what is
 *   staged or done; the download resumes where it stopped.
 *
 * Usage: node wiki_searcher/scripts/fetch-snapshot-bundle.js [bundleDir]   (default ./wiki-bundle)
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { once } from 'events';
import { Readable } from 'stream';
import tar from 'tar-stream';
import { loadEnv } from '../../imright/load-env.js';
import { getAccessToken } from '../../utils/wikimediaAuth.js';

loadEnv();
const { ensureQueueTable, chunkRow, stageChunk, addStagedUnit, doneChunkIds, supersedeUnstagedChunks, setBundleFetcherState } = await import('../chunkQueue.js');

const API_BASE = 'https://api.enterprise.wikimedia.com';
const identifier = process.env.SNAPSHOT_ID || 'enwiki_namespace_0';
const BUNDLE_URL = process.env.BUNDLE_URL || `${API_BASE}/v2/snapshots/${identifier}/download`;
const bundleDir = path.resolve(process.argv[2] || './wiki-bundle');
const bundlePath = path.join(bundleDir, `${identifier}.tar.gz`);
const membersDir = path.join(bundleDir, 'members');
const requestsPath = path.join(bundleDir, 'requests.json');
const logPath = path.join(bundleDir, 'fetch.log');
const MAX_REQUESTS = Number(process.env.BUNDLE_MAX_REQUESTS) || 8;
const STAGE_MAX = Number(process.env.BUNDLE_STAGE_MAX) || 12;
const STALL_MS = 120_000;
const RETRY_PAUSE_MS = Number(process.env.BUNDLE_RETRY_PAUSE_MS) || 30_000;
const MAPPING_CHECKS = 3; // done chunks whose line counts must match before the member→chunk mapping is trusted

fs.mkdirSync(membersDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(message) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}
function say(message) {
  log(message);
  process.stdout.write(`\r\x1b[K${message}\n`);
}

/** Build state dirs next to the bundle dir's parent (wiki-snapshots-v2, -v2b, …): their extracted chunks are not re-staged. */
function workerDirs() {
  const parent = process.cwd();
  return fs
    .readdirSync(parent)
    .filter((name) => /^wiki-snapshots-v2[a-z]?$/.test(name))
    .map((name) => path.join(parent, name))
    .filter((dir) => fs.statSync(dir).isDirectory());
}
function heldLocally(unitId) {
  return workerDirs().some((dir) => fs.existsSync(path.join(dir, `${unitId}.ndjson`)));
}

// ---------------------------------------------------------------- download
const download = { total: null, written: 0, complete: false, failed: null, startedAt: Date.now(), startBytes: 0 };

function loadRequests() {
  try {
    return JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  } catch {
    return { gets: 0, etag: null, history: [] };
  }
}

async function runDownload() {
  const requests = loadRequests();
  const head = await fetch(BUNDLE_URL, { method: 'HEAD', headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  if (!head.ok) {
    download.failed = `HEAD answered ${head.status} ${head.statusText}`;
    return;
  }
  download.total = Number(head.headers.get('content-length'));
  const etag = head.headers.get('etag');
  if (requests.etag && etag && requests.etag !== etag && fs.existsSync(bundlePath)) {
    download.failed = `the snapshot changed since this download started (ETag ${requests.etag} → ${etag}); delete ${bundleDir} and start over`;
    return;
  }
  requests.etag = etag;
  fs.writeFileSync(requestsPath, JSON.stringify(requests, null, 2));
  download.startBytes = fs.existsSync(bundlePath) ? fs.statSync(bundlePath).size : 0;
  download.written = download.startBytes;

  for (;;) {
    const size = fs.existsSync(bundlePath) ? fs.statSync(bundlePath).size : 0;
    download.written = size;
    if (size === download.total) {
      download.complete = true;
      log(`download complete: ${size} bytes, ${requests.gets} GET request(s) in total`);
      return;
    }
    if (size > download.total) {
      download.failed = `${bundlePath} is larger than the snapshot (${size} > ${download.total}); delete it and start over`;
      return;
    }
    if (requests.gets >= MAX_REQUESTS) {
      download.failed = `request cap reached (${requests.gets} GETs, BUNDLE_MAX_REQUESTS=${MAX_REQUESTS}); each may count against the 30 snapshot downloads a month. Raise the cap to continue.`;
      return;
    }
    requests.gets++;
    requests.history.push({ at: new Date().toISOString(), fromByte: size });
    fs.writeFileSync(requestsPath, JSON.stringify(requests, null, 2));

    const headers = { Authorization: `Bearer ${await getAccessToken()}` };
    if (size > 0) headers.Range = `bytes=${size}-`;
    const controller = new AbortController();
    let stall = setTimeout(() => controller.abort(), STALL_MS);
    let writer = null;
    try {
      const response = await fetch(BUNDLE_URL, { headers, signal: controller.signal });
      if (response.status === 429) {
        download.failed = `Wikimedia refused the bundle download with 429: ${(await response.text()).slice(0, 300)}`;
        return;
      }
      if (response.status !== 200 && response.status !== 206) throw new Error(`GET answered ${response.status} ${response.statusText}`);
      if (size > 0 && response.status !== 206) {
        download.failed = 'the server ignored the Range request (would restart from byte 0); stopping rather than spending requests';
        return;
      }
      writer = fs.createWriteStream(bundlePath, { flags: size > 0 ? 'a' : 'w' });
      // A write still in flight when the connection drops fails after the
      // stream is destroyed; without a listener that error would kill the
      // process. The resume logic re-reads the file size, so it is safe to ignore.
      writer.on('error', (error) => log(`bundle write stream: ${error.message}`));
      for await (const piece of response.body) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_MS);
        if (!writer.write(piece)) await once(writer, 'drain');
        download.written += piece.length;
      }
      await new Promise((resolve, reject) => writer.end((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      if (writer) await new Promise((resolve) => writer.destroy(undefined, resolve)).catch(() => {});
      const reason = error.name === 'AbortError' ? `no data for ${STALL_MS / 1000}s` : error.message || error.code;
      say(`⚠ download interrupted at ${(download.written / 1e9).toFixed(2)} GB — ${reason}; resuming in ${RETRY_PAUSE_MS / 1000}s`);
      await sleep(RETRY_PAUSE_MS);
    } finally {
      clearTimeout(stall);
    }
  }
}

/** The bundle file as a stream, following it while it is still being downloaded. */
async function* followBundle(progress) {
  while (!fs.existsSync(bundlePath)) {
    if (download.failed) throw new Error(`download stopped: ${download.failed}`);
    await sleep(1000);
  }
  const handle = await fsp.open(bundlePath, 'r');
  const buffer = Buffer.allocUnsafe(4 << 20);
  let position = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead > 0) {
        position += bytesRead;
        progress.read = position;
        yield Buffer.from(buffer.subarray(0, bytesRead));
        continue;
      }
      if (download.complete && position >= download.total) return;
      if (download.failed) throw new Error(`download stopped: ${download.failed}`);
      await sleep(1000);
    }
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------- split
const stats = { members: 0, staged: 0, skippedDone: 0, skippedHeld: 0, skippedStaged: 0, verified: 0, read: 0 };
let mapping = 'chunks'; // 'chunks' (member n = chunk n) or 'own' (each member its own unit)

async function abandonMapping(reason) {
  mapping = 'own';
  const retired = await supersedeUnstagedChunks(`${identifier}_chunk_`);
  say(`⚠ ${reason}: every member from here on is its own unit of work; ${retired} unstarted snapshot chunk(s) retired in the queue (their articles come from the bundle units)`);
}

function waitingMembers() {
  return fs.readdirSync(membersDir).filter((name) => name.endsWith('.ndjson')).length;
}

async function drain(stream) {
  stream.resume();
  await once(stream, 'end');
}

/** Writes a member to disk, counting lines; returns { file, lines }. */
async function writeMember(stream, unitId) {
  const part = path.join(membersDir, `${unitId}.ndjson.part`);
  const writer = fs.createWriteStream(part);
  let writeError = null;
  writer.on('error', (error) => {
    writeError = error;
  });
  let lines = 0;
  for await (const piece of stream) {
    if (writeError) throw writeError;
    for (let i = 0; i < piece.length; i++) if (piece[i] === 10) lines++;
    if (!writer.write(piece)) await once(writer, 'drain');
  }
  if (writeError) throw writeError;
  await new Promise((resolve, reject) => writer.end((error) => (error ? reject(error) : resolve())));
  return { part, lines };
}

async function stage(part, unitId, register) {
  const file = path.join(membersDir, `${unitId}.ndjson`);
  fs.renameSync(part, file);
  await register(unitId, file);
  stats.staged++;
}

async function handleMember(header, stream) {
  const name = path.basename(header.name);
  if (header.type !== 'file' || !name.endsWith('.ndjson')) return drain(stream);
  stats.members++;
  const number = /_(\d+)\.ndjson$/.exec(name)?.[1];

  if (mapping === 'chunks' && number !== undefined) {
    const chunkId = `${identifier}_chunk_${number}`;
    const row = await chunkRow(chunkId);
    if (row?.done_at) {
      if (stats.verified >= MAPPING_CHECKS || row.total_lines == null) {
        stats.skippedDone++;
        return drain(stream);
      }
      // Check the mapping on a chunk whose line count is known. Written to
      // disk meanwhile, so a mismatch loses nothing: it becomes its own unit.
      const { part, lines } = await writeMember(stream, chunkId);
      if (lines === row.total_lines) {
        stats.verified++;
        stats.skippedDone++;
        fs.rmSync(part, { force: true });
        log(`mapping check ${stats.verified}/${MAPPING_CHECKS}: ${name} has ${lines} lines = ${chunkId}`);
        return;
      }
      await abandonMapping(`${name} has ${lines} lines but ${chunkId} had ${row.total_lines}, so members don't map to chunks`);
      return stage(part, `bundle_${name.replace(/\.ndjson$/, '')}`, addStagedUnit);
    }
    if (row && !row.done_at) {
      if (row.staged_path && (fs.existsSync(row.staged_path) || row.claimed_by)) {
        stats.skippedStaged++;
        return drain(stream);
      }
      if (heldLocally(chunkId)) {
        stats.skippedHeld++;
        return drain(stream);
      }
      while (waitingMembers() >= STAGE_MAX) await sleep(5_000);
      const { part, lines } = await writeMember(stream, chunkId);
      log(`staged ${name} as ${chunkId} (${lines} lines)`);
      return stage(part, chunkId, stageChunk);
    }
    // a chunk id the queue doesn't know: this snapshot's numbering differs
    await abandonMapping(`${name} maps to ${chunkId}, which the chunk queue doesn't know`);
  }

  const unitId = `bundle_${name.replace(/\.ndjson$/, '')}`;
  const row = await chunkRow(unitId);
  if (row?.done_at || (row?.staged_path && fs.existsSync(row.staged_path))) {
    stats.skippedDone++;
    return drain(stream);
  }
  while (waitingMembers() >= STAGE_MAX) await sleep(5_000);
  const { part, lines } = await writeMember(stream, unitId);
  log(`staged ${name} as ${unitId} (${lines} lines)`);
  return stage(part, unitId, addStagedUnit);
}

async function runSplit() {
  const source = Readable.from(followBundle(stats));
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
function formatGB(bytes) {
  return (bytes / 1e9).toFixed(1);
}
function statusLine() {
  const elapsed = (Date.now() - download.startedAt) / 1000;
  const rate = elapsed > 0 ? (download.written - download.startBytes) / elapsed / 1e6 : 0;
  const requests = loadRequests();
  return (
    `bundle: ${formatGB(download.written)}/${download.total ? formatGB(download.total) : '?'} GB downloaded (${rate.toFixed(1)} MB/s, ${requests.gets}/${MAX_REQUESTS} GETs)` +
    ` · read ${formatGB(stats.read)} GB · members ${stats.members}: ${stats.staged} staged, ${stats.skippedDone} done already, ${stats.skippedHeld + stats.skippedStaged} with workers` +
    ` · waiting for workers ${waitingMembers()}/${STAGE_MAX}`
  );
}

await ensureQueueTable();
await setBundleFetcherState('running'); // workers in bundle mode stay up while this is running
say(`Bundle ${BUNDLE_URL} → ${bundlePath}; members staged in ${membersDir}; log: ${logPath}`);
const ticker = setInterval(() => {
  setBundleFetcherState('running').catch(() => {});
  const line = statusLine();
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${line.slice(0, (process.stdout.columns || 200) - 1)}`);
  else log(line);
}, 2_000);

const downloading = runDownload().catch((error) => {
  download.failed = error.message;
});
let splitError = null;
try {
  await runSplit();
} catch (error) {
  splitError = error;
}
await downloading;
clearInterval(ticker);
process.stdout.write('\n');
say(statusLine());

if (splitError) {
  await setBundleFetcherState('stopped').catch(() => {});
  say(`✗ stopped: ${splitError.message}`);
  say('Run this script again to continue: the download resumes and staged/done members are skipped.');
  process.exit(1);
}
await setBundleFetcherState('done');
const done = await doneChunkIds();
say(`Bundle fully read: ${stats.staged} member(s) staged this run, ${stats.skippedDone} already done, ${stats.skippedHeld + stats.skippedStaged} with workers; ${done.size} units done in the queue so far.`);
say(`Leave the workers running until the queue is done, then delete ${bundleDir} (the bundle file alone is ${formatGB(download.total || 0)} GB).`);
process.exit(0);
