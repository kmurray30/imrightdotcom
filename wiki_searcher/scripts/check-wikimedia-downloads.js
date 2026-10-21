#!/usr/bin/env node
/**
 * Asks Wikimedia Enterprise whether this account can download snapshot
 * chunks right now, and prints exactly what it answers (status, rate-limit /
 * quota headers, body). For telling a monthly quota (free tier: 1,500 chunk
 * downloads a month) apart from a short burst limit when the build reports
 * 429s.
 *
 * Makes one HEAD request and one 1-byte GET (Range: bytes=0-0) on a chunk the
 * build has not finished; the GET may count as one download against the
 * monthly quota.
 *
 * Usage: node wiki_searcher/scripts/check-wikimedia-downloads.js [chunk_id]
 */
import { loadEnv } from '../../imright/load-env.js';
import { getAccessToken } from '../../utils/wikimediaAuth.js';

loadEnv();
const API_BASE = 'https://api.enterprise.wikimedia.com';
const identifier = 'enwiki_namespace_0';

async function pickChunk() {
  if (process.argv[2]) return process.argv[2];
  try {
    const { getPool } = await import('../../imright/scripts/db.js');
    const pool = getPool();
    const { rows } = await pool.query("SELECT chunk_id FROM wiki_build_chunks WHERE done_at IS NULL ORDER BY claimed_by IS NOT NULL, ord LIMIT 1");
    await pool.end();
    if (rows[0]) return rows[0].chunk_id;
  } catch {
    // no database: fall through
  }
  return `${identifier}_chunk_0`;
}

function show(label, response, body = '') {
  console.log(`\n${label}: ${response.status} ${response.statusText}`);
  for (const [name, value] of response.headers) {
    if (/^(set-cookie|date|server|via|x-amz-cf-|x-cache|alt-svc|connection|cf-ray)/i.test(name)) continue;
    console.log(`  ${name}: ${value}`);
  }
  if (body) console.log(`  body: ${body.slice(0, 800).replace(/\s+/g, ' ')}`);
}

const chunkId = await pickChunk();
const url = `${API_BASE}/v2/snapshots/${identifier}/chunks/${chunkId}/download`;
const headers = { Authorization: `Bearer ${await getAccessToken()}` };
console.log(`Checking ${chunkId}`);

const head = await fetch(url, { method: 'HEAD', headers });
show('HEAD', head);

const controller = new AbortController();
const get = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal: controller.signal });
let body = '';
if (get.status >= 400) body = await get.text();
else controller.abort();
show('GET (1 byte)', get, body);

console.log(
  get.ok || get.status === 206
    ? '\nDownloads work right now.'
    : get.status === 429
      ? '\nRefused with 429. If the body or headers mention a quota or monthly limit, waiting minutes will not help; see the account dashboard for the reset date.'
      : `\nRefused with ${get.status}.`
);
process.exit(0);
