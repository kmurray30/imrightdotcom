#!/usr/bin/env node
/**
 * Measures embedding throughput on THIS machine across devices, precisions
 * and batch sizes, to pick EMBED_DEVICE / EMBED_DTYPE / EMBED_BATCH_SIZE (see
 * textEmbeddings.js's embedConfig).
 *
 * Uses REAL paragraphs sampled from the index, so the length mix — and
 * therefore padding waste, which dominates GPU cost when one long paragraph
 * shares a call with short ones — matches the actual build. Runs them through
 * the exact production path (loadExtractor + embedSorted), shaped like the
 * build calls it: one call per article batch (CALL_SIZE texts), IN_FLIGHT
 * calls at once (the build runs EMBED_CONCURRENCY = 4 chunks in parallel).
 *
 * Parity: every config's vectors are compared (cosine) with the vectors
 * ALREADY STORED in the index for those same paragraphs. Only switch to a
 * config whose minCos stays above ~0.999 — fp32 on any device should read
 * ~1.00000; fp16 will drift a little.
 *
 * A config that fails to load (unsupported device, no fp16 model file) is
 * reported and skipped, not fatal. Needs DATABASE_URL (db tunnel running).
 *
 * Usage: node wiki_searcher/scripts/benchmark-embed-device.js [device ...]   (default: cpu webgpu)
 *   DTYPES=fp32,fp16          precisions for non-CPU devices (CPU always runs fp32 only, as the baseline)
 *   BATCH_SIZES=2,4,8,16      EMBED_BATCH_SIZE values to sweep
 *   SAMPLE=400                paragraphs to sample from the index
 *   CALL_SIZE=40 IN_FLIGHT=4  call shape
 */
import { loadEnv } from '../../imright/load-env.js';
import { getPool } from '../../imright/scripts/db.js';
import { loadExtractor, embedSorted } from '../textEmbeddings.js';

loadEnv();

const listEnv = (name, fallback) =>
  (process.env[name] || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const devices = process.argv.length > 2 ? process.argv.slice(2) : ['cpu', 'webgpu'];
const dtypes = listEnv('DTYPES', 'fp32,fp16');
const batchSizes = listEnv('BATCH_SIZES', '2,4,8,16').map(Number);
const SAMPLE = Number(process.env.SAMPLE) || 400;
const CALL_SIZE = Number(process.env.CALL_SIZE) || 40;
const IN_FLIGHT = Number(process.env.IN_FLIGHT) || 4;

async function sampleParagraphs() {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set — this benchmark samples real paragraphs from the index (start the db tunnel).');
  // TABLESAMPLE reads a random ~0.1% of the table's pages, instead of
  // scanning and sorting the whole multi-GB table like ORDER BY random().
  const { rows } = await pool.query(
    `SELECT title, section, paragraph_text, embedding::text AS embedding
     FROM wiki_paragraph_embeddings TABLESAMPLE SYSTEM (0.1)
     LIMIT $1`,
    [SAMPLE]
  );
  await pool.end();
  if (rows.length === 0) throw new Error('Sampled 0 paragraphs — is the index populated?');
  return rows.map((row) => ({
    text: `${row.title} — ${row.section}: ${row.paragraph_text}`, // exactly what embeddingIndex.js embeds
    stored: JSON.parse(row.embedding),
  }));
}

async function runCalls(extractor, calls, batchSize) {
  const vectorsByCall = new Array(calls.length);
  let callMsTotal = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < calls.length) {
      const c = cursor++;
      const callStart = performance.now();
      vectorsByCall[c] = await embedSorted(extractor, calls[c], batchSize);
      callMsTotal += performance.now() - callStart;
    }
  }
  const start = performance.now();
  await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
  return { elapsedMs: performance.now() - start, avgCallMs: callMsTotal / calls.length, vectors: vectorsByCall.flat() };
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum; // both sides unit-normalized, so this is cosine similarity
}

const samples = await sampleParagraphs();
const texts = samples.map((s) => s.text);
const calls = [];
for (let i = 0; i < texts.length; i += CALL_SIZE) calls.push(texts.slice(i, i + CALL_SIZE));

const lengths = texts.map((t) => t.length).sort((a, b) => a - b);
const pct = (p) => lengths[Math.min(lengths.length - 1, Math.floor(p * lengths.length))];
console.log(
  `Sampled ${texts.length} real paragraphs — length in chars: median ${pct(0.5)}, p90 ${pct(0.9)}, max ${pct(1)}. ` +
    `${calls.length} calls of ≤${CALL_SIZE}, ${IN_FLIGHT} in flight.\n`
);

const rows = [];
for (const device of devices) {
  for (const dtype of device === 'cpu' ? ['fp32'] : dtypes) {
    console.log(`${device}/${dtype}: loading...`);
    let extractor;
    try {
      extractor = await loadExtractor(device, dtype);
    } catch (error) {
      console.log(`  unavailable — ${error.message}`);
      rows.push({ device, dtype, note: 'unavailable' });
      continue;
    }

    // One untimed call first: some backends compile kernels on first use.
    await embedSorted(extractor, calls[0], batchSizes[0]);

    for (const batchSize of batchSizes) {
      const { elapsedMs, avgCallMs, vectors } = await runCalls(extractor, calls, batchSize);
      const sims = vectors.map((v, i) => dot(v, samples[i].stored));
      rows.push({
        device,
        dtype,
        batch: batchSize,
        avgCallMs: avgCallMs.toFixed(0),
        textsPerSec: ((texts.length / elapsedMs) * 1000).toFixed(0),
        minCos: Math.min(...sims).toFixed(5),
        meanCos: (sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(5),
      });
      console.log(`  batch ${batchSize}: ${rows.at(-1).textsPerSec} texts/s`);
    }
    await extractor.dispose?.();
  }
}

console.log();
console.table(rows);
console.log('Pick the fastest row whose minCos stays above ~0.999, then set EMBED_DEVICE / EMBED_DTYPE / EMBED_BATCH_SIZE in env.local.');
