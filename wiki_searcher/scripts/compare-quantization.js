#!/usr/bin/env node
/**
 * How much search quality each compression of the span vectors keeps, before
 * choosing what to hold in the app's RAM. Read-only; nothing is deployed.
 *
 * Compared against exact search over all spans (cosine on the stored 256-dim
 * halfvec), for real search terms:
 * - PQ (product quantization, wiki_searcher/pq.js) at 32 and 16 bytes per
 *   span, on the full 256 dims and on the first 128 (re-normalized; arctic
 *   is trained so its first dims carry most of the meaning);
 * - plain 128 dims, uncompressed (the dimension cut alone);
 * - 1 bit per dim (sign), as the disk index used.
 * Each is scanned exhaustively, so the numbers isolate the compression (a
 * cluster index on top adds a small, tunable loss). For each, the top 10 by
 * its own score, and the top 10 after re-ranking its best 50-800 by the
 * exact score (as a second stage reading full vectors would): recall against
 * the exact top 10, and how much less similar they are on average.
 *
 * One pass over every vector, streamed from Postgres in id ranges of
 * CHUNK_IDS (default 250,000). Each range is fetched whole and retried on
 * a dropped connection (statement timeouts are off, so a slow disk only
 * slows it down), then scored by worker threads (WORKERS, default: cores - 1).
 *
 * Usage: node wiki_searcher/scripts/compare-quantization.js
 */
import os from 'os';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { decodeHalfInto, normalizedPrefix, kmeans, centroidNorms, encode, adcScore, buildLut, TopK } from '../pq.js';

const DIMS = 256;
const CONFIGS = [
  { name: '256d PQ32', dims: 256, m: 32 },
  { name: '256d PQ16', dims: 256, m: 16 },
  { name: '128d PQ32', dims: 128, m: 32 },
  { name: '128d PQ16', dims: 128, m: 16 },
];
const K = 10;
const KEEP = 800; // candidates kept per query and method, for the re-rank columns
const RERANKS = [50, 100, 200, 400, 800];
const BATCH = 8192;

const QUERIES = [
  // from check-span-search.js
  '5G towers cause cancer',
  'vaccines contain microchips',
  'the moon landing was faked',
  'fluoride in drinking water lowers IQ',
  'eating broccoli prevents cancer',
  'Gabe Newell founded Valve',
  'the human heart beats about three billion times in a lifetime',
  'passengers of the Titanic who died',
  'eating feces as medicine',
  'Area 51 hides alien spacecraft',
  'the Great Wall of China is visible from space',
  'coffee dehydrates you',
  'sugar makes children hyperactive',
  'humans only use ten percent of their brains',
  'TAS2R38',
  'goitrogens in broccoli',
  // search terms the conspirator generated for real claims (compare-providers.js)
  'athlete sudden cardiac death',
  'small mammals have much faster heart rates and shorter lifespans than large mammals, showing heartbeats determine lifespan',
  'resting heart rate longevity',
  'beta blocker drugs that lower heart rate are linked to longer survival in heart patients, indicating fewer beats help',
  'hibernating animal lifespan',
  'Titanic passenger list',
  'John Jacob Astor IV',
  "The ship's designer Thomas Andrews went down with the Titanic, showing the most technically important person died, not the celebrities.",
  'Wallace Hartley Titanic',
  'Edward Smith Titanic captain',
  'Steam digital game distribution market share',
  'Gabe Newell net worth and Valve valuation',
  'Valve loot box and microtransaction policies',
  "Valve's early access program lets Newell decide which games get public exposure and funding before full release",
  'Steam early access program',
  'Fecal microbiota transplant',
  'Gut microbiome',
  'Traditional medicine animal feces',
  'Koala pap',
  'Dung beetle',
  'Environmental Working Group pesticide list',
  'water footprint',
  'foodborne illness outbreaks',
  'California agricultural production',
];

function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// ------------------------------------------------------------------ worker
function workerMain() {
  const { sample, sampleRows } = workerData;
  let state = null;

  parentPort.on('message', (message) => {
    if (message.type === 'train') {
      const { dims, start, sub, iterations } = message;
      const data = dims === DIMS ? sample.v256 : sample.v128;
      const centroids = kmeans(data, sampleRows, dims, start, sub, 256, { iterations, seed: 17 + start });
      parentPort.postMessage({ type: 'trained', id: message.id, centroids }, [centroids.buffer]);
      return;
    }
    if (message.type === 'setup') {
      const { queries256, queries128, configs } = message;
      const q = queries256.length / DIMS;
      const queryBits = new Uint32Array(q * 8);
      for (let i = 0; i < q; i++) for (let d = 0; d < DIMS; d++) if (queries256[i * DIMS + d] > 0) queryBits[i * 8 + (d >> 5)] |= 1 << (d & 31);
      state = {
        q,
        queries256,
        queries128,
        queryBits,
        configs: configs.map((c) => ({ ...c, norms: centroidNorms(c.codebooks, c.dims, c.m) })),
        exact: Array.from({ length: q }, () => new TopK(K)),
        dims128: Array.from({ length: q }, () => new TopK(KEEP)),
        binary: Array.from({ length: q }, () => new TopK(KEEP)),
        pq: configs.map(() => Array.from({ length: q }, () => new TopK(KEEP))),
        v256: new Float32Array(DIMS),
        v128: new Float32Array(128),
        exactScores: new Float64Array(q),
        bits: new Uint32Array(8),
        codes: new Uint8Array(32),
      };
      parentPort.postMessage({ type: 'ready' });
      return;
    }
    if (message.type === 'batch') {
      scoreBatch(state, message.ids, message.half, message.count);
      parentPort.postMessage({ type: 'done' });
      return;
    }
    if (message.type === 'finish') {
      const dump = (heaps) => heaps.map((h) => h.sorted());
      parentPort.postMessage({
        type: 'results',
        exact: dump(state.exact),
        dims128: dump(state.dims128),
        binary: dump(state.binary),
        pq: state.pq.map(dump),
      });
    }
  });
}

function scoreBatch(s, ids, half, count) {
  const { q, queries256, queries128, queryBits, v256, v128, exactScores, bits, codes } = s;
  for (let r = 0; r < count; r++) {
    const id = ids[r];
    decodeHalfInto(half, r * 2 * DIMS, DIMS, v256, 0);
    normalizedPrefix(v256, 0, 128, v128, 0);
    bits.fill(0);
    for (let d = 0; d < DIMS; d++) if (v256[d] > 0) bits[d >> 5] |= 1 << (d & 31);

    for (let i = 0; i < q; i++) {
      let exact = 0;
      const qb = i * DIMS;
      for (let d = 0; d < DIMS; d++) exact += v256[d] * queries256[qb + d];
      exactScores[i] = exact;
      s.exact[i].push(exact, id);

      let short = 0;
      const qs = i * 128;
      for (let d = 0; d < 128; d++) short += v128[d] * queries128[qs + d];
      if (short > s.dims128[i].floor) s.dims128[i].push(short, id, exact);

      let hamming = 0;
      for (let w = 0; w < 8; w++) hamming += popcount32(bits[w] ^ queryBits[i * 8 + w]);
      const binaryScore = DIMS - 2 * hamming;
      if (binaryScore > s.binary[i].floor) s.binary[i].push(binaryScore, id, exact);
    }

    for (let c = 0; c < s.configs.length; c++) {
      const config = s.configs[c];
      if (config.dims === DIMS) encode(v256, 0, config.codebooks, config.norms, DIMS, config.m, codes, 0);
      else encode(v128, 0, config.codebooks, config.norms, 128, config.m, codes, 0);
      const lutSize = config.m * 256;
      for (let i = 0; i < q; i++) {
        const score = adcScore(config.luts.subarray(i * lutSize, (i + 1) * lutSize), codes, 0, config.m);
        if (score > s.pq[c][i].floor) s.pq[c][i].push(score, id, exactScores[i]);
      }
    }
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const { loadEnv } = await import('../../imright/load-env.js');
  loadEnv();
  const { default: pg } = await import('pg');
  const { default: copyStreams } = await import('pg-copy-streams');
  const { shouldUseSsl } = await import('../../imright/scripts/db.js');
  const { embedQueries } = await import('../arcticEmbeddings.js');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const chunkIds = Number(process.env.CHUNK_IDS) || 250_000;
  const workerCount = Number(process.env.WORKERS) || Math.max(1, os.cpus().length - 1);
  const log = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

  let client = null;
  async function connect() {
    if (client) await client.end().catch(() => {});
    client = new pg.Client({ connectionString, ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false, keepAlive: true });
    client.on('error', () => {}); // surfaced by the failing query instead
    await client.connect();
    await client.query('SET statement_timeout = 0'); // a slow disk makes it slow, never cancelled
    await client.query('SET default_transaction_read_only = on');
  }
  async function withRetry(label, fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        if (!client) await connect();
        return await fn();
      } catch (error) {
        if (attempt >= 8) throw error;
        const pause = Math.min(60_000, 2000 * 2 ** (attempt - 1));
        log(`${label}: ${error.message} — retrying in ${pause / 1000}s (attempt ${attempt + 1})`);
        await new Promise((resolve) => setTimeout(resolve, pause));
        client = null;
      }
    }
  }
  /** Runs a COPY ... TO STDOUT (FORMAT binary) and returns its whole output. */
  function copyAll(sql) {
    return withRetry('copy', () => new Promise((resolve, reject) => {
      const parts = [];
      const stream = client.query(copyStreams.to(sql));
      stream.on('data', (part) => parts.push(part));
      stream.on('end', () => resolve(Buffer.concat(parts)));
      stream.on('error', reject);
    }));
  }
  /** Rows of a binary COPY: calls onRow(fields) with [offset, length] per field. */
  function eachRow(buffer, onRow) {
    let p = 11; // signature
    p += 4; // flags
    p += 4 + buffer.readInt32BE(p); // header extension
    for (;;) {
      const fieldCount = buffer.readInt16BE(p);
      p += 2;
      if (fieldCount === -1) break;
      const fields = [];
      for (let f = 0; f < fieldCount; f++) {
        const length = buffer.readInt32BE(p);
        p += 4;
        fields.push([p, length]);
        p += Math.max(0, length);
      }
      onRow(fields);
    }
  }

  // 1. Query vectors, as the site embeds them.
  log(`Embedding ${QUERIES.length} queries...`);
  const queryVectors = await embedQueries(QUERIES);
  const queries256 = new Float32Array(QUERIES.length * DIMS);
  const queries128 = new Float32Array(QUERIES.length * 128);
  queryVectors.forEach((v, i) => {
    queries256.set(v, i * DIMS);
    normalizedPrefix(v, 0, 128, queries128, i * 128);
  });

  // 2. Training sample for the codebooks.
  log('Fetching a ~100k-span training sample...');
  const sampleBuffer = await copyAll(
    'COPY (SELECT embedding FROM wiki_citation_spans TABLESAMPLE SYSTEM (0.2) REPEATABLE (7) LIMIT 100000) TO STDOUT (FORMAT binary)'
  );
  const sampleHalves = [];
  eachRow(sampleBuffer, ([[offset]]) => sampleHalves.push(offset + 4));
  const sampleRows = sampleHalves.length;
  const sample = { v256: new Float32Array(new SharedArrayBuffer(sampleRows * DIMS * 4)), v128: new Float32Array(new SharedArrayBuffer(sampleRows * 128 * 4)) };
  sampleHalves.forEach((offset, i) => {
    decodeHalfInto(sampleBuffer, offset, DIMS, sample.v256, i * DIMS);
    normalizedPrefix(sample.v256, i * DIMS, 128, sample.v128, i * 128);
  });
  log(`Training sample: ${sampleRows.toLocaleString()} spans.`);

  // Worker pool.
  const workers = Array.from({ length: workerCount }, () => new Worker(new URL(import.meta.url), { workerData: { sample, sampleRows } }));
  const pending = workers.map(() => 0);
  const waiters = [];
  const handlers = new Map();
  let nextId = 0;
  workers.forEach((worker, w) => {
    worker.on('error', (error) => {
      console.error(`worker ${w} failed: ${error.stack || error}`);
      process.exit(1);
    });
    worker.on('message', (message) => {
      if (message.type === 'trained') handlers.get(message.id)(message.centroids);
      else if (message.type === 'done') {
        pending[w]--;
        waiters.splice(0).forEach((resolve) => resolve());
      } else handlers.get(`${message.type}:${w}`)?.(message);
    });
  });
  const request = (w, type, payload = {}, transfer = []) => new Promise((resolve) => {
    handlers.set(`${type === 'setup' ? 'ready' : 'results'}:${w}`, resolve);
    workers[w].postMessage({ type, ...payload }, transfer);
  });

  // 3. Codebooks: one k-means per subspace, spread over the workers.
  log(`Training codebooks (${CONFIGS.map((c) => c.name).join(', ')}) on ${workerCount} threads...`);
  const trainStart = Date.now();
  const tasks = CONFIGS.flatMap((config, c) => Array.from({ length: config.m }, (_, s) => ({ c, s, sub: config.dims / config.m, dims: config.dims })));
  const codebooks = CONFIGS.map((config) => new Float32Array(config.m * 256 * (config.dims / config.m)));
  let taskIndex = 0;
  await Promise.all(workers.map(async (worker) => {
    while (taskIndex < tasks.length) {
      const task = tasks[taskIndex++];
      const id = nextId++;
      const centroids = await new Promise((resolve) => {
        handlers.set(id, resolve);
        worker.postMessage({ type: 'train', id, dims: task.dims, start: task.s * task.sub, sub: task.sub, iterations: 15 });
      });
      codebooks[task.c].set(centroids, task.s * 256 * task.sub);
    }
  }));
  log(`Codebooks trained in ${((Date.now() - trainStart) / 1000).toFixed(0)} s.`);

  const configs = CONFIGS.map((config, c) => {
    const lutSize = config.m * 256;
    const luts = new Float32Array(QUERIES.length * lutSize);
    for (let i = 0; i < QUERIES.length; i++) {
      const query = config.dims === DIMS ? queries256.subarray(i * DIMS, (i + 1) * DIMS) : queries128.subarray(i * 128, (i + 1) * 128);
      luts.set(buildLut(query, codebooks[c], config.dims, config.m), i * lutSize);
    }
    return { ...config, codebooks: codebooks[c], luts };
  });
  await Promise.all(workers.map((_, w) => request(w, 'setup', { queries256, queries128, configs })));

  // 4. One pass over every span, in id ranges.
  const { rows: [range] } = await withRetry('range', () =>
    client.query(`SELECT min(id)::bigint AS lo, max(id)::bigint AS hi, (SELECT reltuples::bigint FROM pg_class WHERE relname = 'wiki_citation_spans') AS estimate FROM wiki_citation_spans`)
  );
  const lo = Number(range.lo);
  const hi = Number(range.hi);
  const estimate = Number(range.estimate);
  log(`Scanning ids ${lo.toLocaleString()}–${hi.toLocaleString()} (~${estimate.toLocaleString()} spans) in ranges of ${chunkIds.toLocaleString()}...`);
  const fetchRange = (start) =>
    copyAll(`COPY (SELECT id, embedding FROM wiki_citation_spans WHERE id >= ${start} AND id < ${start + chunkIds}) TO STDOUT (FORMAT binary)`);
  const scanStart = Date.now();
  let scanned = 0;
  let lastLog = 0;
  let next = fetchRange(lo);
  let round = 0;
  for (let start = lo; start <= hi; start += chunkIds) {
    const buffer = await next;
    if (start + chunkIds <= hi) next = fetchRange(start + chunkIds); // fetch the next range while this one is scored
    const offsets = [];
    eachRow(buffer, (fields) => offsets.push(fields));
    for (let b = 0; b < offsets.length; b += BATCH) {
      const rows = offsets.slice(b, b + BATCH);
      const ids = new Float64Array(rows.length);
      const half = new Uint8Array(rows.length * 2 * DIMS);
      rows.forEach(([[idOffset], [embeddingOffset]], r) => {
        ids[r] = Number(buffer.readBigInt64BE(idOffset));
        half.set(buffer.subarray(embeddingOffset + 4, embeddingOffset + 4 + 2 * DIMS), r * 2 * DIMS);
      });
      for (;;) {
        const w = round++ % workers.length;
        if (pending[w] < 2) {
          pending[w]++;
          workers[w].postMessage({ type: 'batch', ids, half, count: rows.length }, [ids.buffer, half.buffer]);
          break;
        }
        if (pending.every((n) => n >= 2)) await new Promise((resolve) => waiters.push(resolve));
      }
    }
    scanned += offsets.length;
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      const rate = scanned / ((Date.now() - scanStart) / 1000);
      log(`${scanned.toLocaleString()} spans scanned (${((scanned / estimate) * 100).toFixed(1)}%), ${Math.round(rate).toLocaleString()}/s, ~${Math.round((estimate - scanned) / rate / 60)} min left`);
    }
  }
  while (pending.some((n) => n > 0)) await new Promise((resolve) => waiters.push(resolve));
  log(`Scanned ${scanned.toLocaleString()} spans in ${((Date.now() - scanStart) / 60000).toFixed(1)} min.`);
  await client.end().catch(() => {});

  // 5. Merge the workers' results and report.
  const results = await Promise.all(workers.map((_, w) => request(w, 'finish')));
  const merge = (pick, keep) =>
    QUERIES.map((_, i) => {
      const top = new TopK(keep);
      for (const r of results) for (const item of pick(r)[i]) top.push(item.score, item.id, item.extra);
      return top.sorted();
    });
  const exact = merge((r) => r.exact, K);
  const methods = [
    ...CONFIGS.map((config, c) => ({ name: config.name, bytes: config.m, candidates: merge((r) => r.pq[c], KEEP) })),
    { name: '128d float16 (no PQ)', bytes: 256, candidates: merge((r) => r.dims128, KEEP) },
    { name: '256d 1-bit (disk index)', bytes: 32, candidates: merge((r) => r.binary, KEEP) },
  ];

  const reference = exact.map((top) => ({ ids: new Set(top.map((item) => item.id)), mean: top.reduce((sum, item) => sum + item.score, 0) / top.length }));
  const measure = (candidates, rerank) => {
    let recall = 0;
    let lost = 0;
    candidates.forEach((list, i) => {
      const top = rerank ? list.slice(0, rerank).sort((a, b) => b.extra - a.extra).slice(0, K) : list.slice(0, K);
      recall += top.filter((item) => reference[i].ids.has(item.id)).length / K;
      lost += reference[i].mean - top.reduce((sum, item) => sum + item.extra, 0) / Math.max(1, top.length);
    });
    return { recall: recall / candidates.length, lost: lost / candidates.length };
  };
  const meanSimilarity = reference.reduce((sum, r) => sum + r.mean, 0) / reference.length;
  const cell = ({ recall, lost }) => `${recall.toFixed(2)} / ${lost.toFixed(3)}`.padEnd(14);
  console.log(`\nAgainst exact search over ${scanned.toLocaleString()} spans, ${QUERIES.length} queries (exact top-${K} mean similarity ${meanSimilarity.toFixed(3)}).`);
  console.log(`Each cell: recall@${K} / similarity lost. "Re-rank N": best N by the method's score, re-ranked by the exact score.\n`);
  console.log(`${'method'.padEnd(26)}${'RAM for codes'.padEnd(15)}${'own score'.padEnd(14)}${RERANKS.map((n) => `re-rank ${n}`.padEnd(14)).join('')}`);
  const report = [];
  for (const method of methods) {
    const gb = ((method.bytes + 4) * scanned) / 1e9; // + a 4-byte row number per span
    const own = measure(method.candidates, 0);
    const reranked = RERANKS.map((n) => measure(method.candidates, n));
    console.log(`${method.name.padEnd(26)}${`${gb.toFixed(1)} GB`.padEnd(15)}${cell(own)}${reranked.map(cell).join('')}`);
    report.push({ method: method.name, bytesPerSpan: method.bytes, gb, own, reranked: Object.fromEntries(RERANKS.map((n, i) => [n, reranked[i]])) });
  }
  console.log(`\nQUANT_RESULT ${JSON.stringify({ spans: scanned, queries: QUERIES.length, meanSimilarity, report })}`);
  await Promise.all(workers.map((worker) => worker.terminate()));
  process.exit(0);
}

if (isMainThread) {
  main().catch((error) => {
    console.error(`Failed: ${error.stack || error.message}`);
    process.exit(1);
  });
} else {
  workerMain();
}
