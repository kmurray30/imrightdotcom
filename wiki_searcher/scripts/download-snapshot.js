#!/usr/bin/env node
/**
 * Downloads (resumably) and extracts a Wikimedia Enterprise Snapshot — the
 * raw text+structure corpus that build-index-from-snapshot.js consumes.
 * Auth is fully automatic via utils/wikimediaAuth.js, the same module the
 * running app uses — it handles minting/refreshing both the access and
 * refresh tokens itself; nothing to copy-paste here.
 *
 * Resumable per the Snapshot API's documented flow (HEAD for
 * Content-Length/ETag, GET with Range to resume, an ETag mismatch means the
 * snapshot rotated so we restart, 416 means it's already complete) — a
 * multi-GB download shouldn't have to start over just because the
 * connection dropped partway through.
 *
 * NOTE: this leans on Node's fetch stripping the Authorization header on
 * the cross-origin redirect to the presigned download URL, the same way
 * curl does per the docs, and forwarding the Range header through that
 * redirect. Not verified against a live run in this environment (network
 * access to Wikimedia is blocked here) — watch the first run's output for
 * an auth error on the redirected request.
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

loadEnv();
const execFileAsync = promisify(execFile);

const API_BASE = 'https://api.enterprise.wikimedia.com';
const identifier = process.argv[2] || 'enwiki_namespace_0';
const destDir = process.argv[3] || './wiki-snapshots';

const archivePath = path.join(destDir, `${identifier}.tar.gz`);
const etagSidecarPath = `${archivePath}.etag`;

const PROGRESS_BAR_WIDTH = 30;
const PROGRESS_RENDER_INTERVAL_MS = 200;

function formatGB(bytes) {
  return (bytes / 1e9).toFixed(2);
}

/** Renders/overwrites a single terminal line: [bar] pct% downloaded/total GB. */
function renderProgress(downloadedBytes, totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    process.stdout.write(`\r${formatGB(downloadedBytes)} GB downloaded (total size unknown)`);
    return;
  }
  const fraction = Math.min(1, downloadedBytes / totalBytes);
  const filled = Math.round(fraction * PROGRESS_BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
  const pct = (fraction * 100).toFixed(1).padStart(5, ' ');
  process.stdout.write(`\r[${bar}] ${pct}%  ${formatGB(downloadedBytes)} / ${formatGB(totalBytes)} GB`);
}

async function headSnapshot(accessToken) {
  const response = await fetch(`${API_BASE}/v2/snapshots/${identifier}/download`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`HEAD failed: ${response.status} ${response.statusText}`);
  }
  return {
    contentLength: Number(response.headers.get('content-length')),
    etag: response.headers.get('etag'),
    acceptsRanges: response.headers.get('accept-ranges') === 'bytes',
  };
}

function existingPartialSize() {
  return fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0;
}

function readSidecarEtag() {
  return fs.existsSync(etagSidecarPath) ? fs.readFileSync(etagSidecarPath, 'utf8').trim() : null;
}

async function downloadSnapshot() {
  fs.mkdirSync(destDir, { recursive: true });
  const accessToken = await getAccessToken();

  const { contentLength, etag, acceptsRanges } = await headSnapshot(accessToken);
  console.log(`Snapshot ${identifier}: ${(contentLength / 1e9).toFixed(2)} GB, etag ${etag}`);

  let startByte = existingPartialSize();
  if (startByte > 0) {
    const previousEtag = readSidecarEtag();
    if (previousEtag !== etag) {
      console.log('Snapshot rotated since the last partial download (ETag changed) — starting over.');
      fs.rmSync(archivePath, { force: true });
      startByte = 0;
    } else if (startByte >= contentLength) {
      console.log('Already fully downloaded — skipping to extraction.');
      return;
    } else {
      console.log(`Resuming from byte ${startByte} of ${contentLength}...`);
    }
  }
  fs.writeFileSync(etagSidecarPath, etag ?? '');

  const headers = { Authorization: `Bearer ${accessToken}` };
  const isResuming = startByte > 0 && acceptsRanges;
  if (isResuming) headers.Range = `bytes=${startByte}-`;

  const response = await fetch(`${API_BASE}/v2/snapshots/${identifier}/download`, { headers });

  if (response.status === 416) {
    console.log('Server reports range not satisfiable — file is already complete.');
    return;
  }
  if (!response.ok && response.status !== 206) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const writeStream = fs.createWriteStream(archivePath, { flags: isResuming ? 'a' : 'w' });
  let downloadedBytes = startByte; // total bytes now on disk, including anything from a prior resumed run
  let lastRenderAt = 0;

  for await (const chunk of Readable.fromWeb(response.body)) {
    downloadedBytes += chunk.length;
    if (!writeStream.write(chunk)) {
      await new Promise((resolve) => writeStream.once('drain', resolve));
    }
    const now = Date.now();
    if (now - lastRenderAt >= PROGRESS_RENDER_INTERVAL_MS) {
      renderProgress(downloadedBytes, contentLength);
      lastRenderAt = now;
    }
  }
  renderProgress(downloadedBytes, contentLength);
  process.stdout.write('\n');

  await new Promise((resolve, reject) => {
    writeStream.end((error) => (error ? reject(error) : resolve()));
  });

  const finalSize = fs.statSync(archivePath).size;
  console.log(`Downloaded — file is now ${(finalSize / 1e9).toFixed(2)} GB.`);
  if (Number.isFinite(contentLength) && contentLength > 0 && finalSize !== contentLength) {
    throw new Error(
      `Size mismatch: expected ${contentLength} bytes, got ${finalSize}. Re-run this script to resume/retry.`
    );
  }
}

async function extractSnapshot() {
  console.log('Extracting...');
  await execFileAsync('tar', ['xzf', archivePath], { cwd: destDir });
  console.log(`Done. Look for the extracted .ndjson file in ${destDir}/`);
}

async function main() {
  await downloadSnapshot();
  await extractSnapshot();
  fs.rmSync(etagSidecarPath, { force: true });
  console.log(`\nNext: node wiki_searcher/scripts/build-index-from-snapshot.js ${destDir}/<the-extracted-file>.ndjson`);
}

main().catch((error) => {
  console.error('Fatal error:', error.message);
  console.error('Re-run this script to resume — the partial download and its .etag sidecar are left in place on failure.');
  process.exit(1);
});
