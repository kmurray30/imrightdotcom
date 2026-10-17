#!/usr/bin/env node
/**
 * Side-by-side quality check of embedding setups on the same random sample of
 * real paragraphs, before committing to a full re-embed. Read-only on the
 * database (it only SELECTs a sample of paragraph text).
 *
 * For each query, prints the top paragraphs found by:
 *   - bge-small        the current model, as the live index embeds queries
 *   - bge-small+prefix the same, with bge's retrieval instruction on the query
 *   - arctic-768       Snowflake arctic-embed-m-v1.5, full size (reference)
 *   - arctic-256       cut to 256 dims (Matryoshka-trained to survive this)
 *   - arctic-256 8-bit / 4-bit, arctic-128 4-bit   compressed variants, each
 *                      with how many of its results match arctic-768's
 * plus arctic's embedding speed on this machine.
 *
 * Results come from a sample (default 50K paragraphs), not the full 22.9M
 * index — it's a like-for-like comparison of the setups, not production
 * results. The sample's embeddings are cached on disk, so re-running with
 * new queries is instant.
 *
 * Usage: node wiki_searcher/scripts/compare-embedding-models.js "<query>" ["<query>" ...] [--sample N] [--top N]
 *   EMBED_DEVICE / EMBED_DTYPE / EMBED_BATCH_SIZE apply to both models (see textEmbeddings.js).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from '@huggingface/transformers';
import { loadEnv } from '../../imright/load-env.js';

loadEnv();
process.env.DB_STATEMENT_TIMEOUT_MS ??= '0';
const { getPool } = await import('../../imright/scripts/db.js');
const { loadExtractor, embedConfig } = await import('../textEmbeddings.js');

const ARCTIC_MODEL = 'Snowflake/snowflake-arctic-embed-m-v1.5';
const ARCTIC_DIMS = 768;
const BGE_DIMS = 384;
// Both models were trained with this instruction on short search queries
// only (passages are embedded without it).
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const TOTAL_PARAGRAPHS = 22_951_054;
const SNIPPET_LENGTH = 140;

function parseArgs(argv) {
  const options = { queries: [], sample: 50_000, top: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sample') options.sample = Number(argv[++i]);
    else if (argv[i] === '--top') options.top = Number(argv[++i]);
    else options.queries.push(argv[i]);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.queries.length === 0 || !(options.sample >= 100) || !(options.top >= 1)) {
  console.error('Usage: node wiki_searcher/scripts/compare-embedding-models.js "<query>" ["<query>" ...] [--sample N] [--top N]');
  process.exit(1);
}

const cacheDir = path.join(os.homedir(), '.cache', 'imright-embed-compare', `sample-${options.sample}`);
fs.mkdirSync(cacheDir, { recursive: true });
const metaPath = path.join(cacheDir, 'meta.json');
const vectorPath = (name) => path.join(cacheDir, `${name}.f32`);

function readVectors(name) {
  const buffer = fs.readFileSync(vectorPath(name));
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/** Length-sorted batches (less padding), results scattered back to input order, flattened into one Float32Array. */
async function embedAll(extractor, texts, dims, pooling, label) {
  const { batchSize } = embedConfig();
  const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
  const out = new Float32Array(texts.length * dims);
  const start = performance.now();
  let lastPrint = 0;
  for (let s = 0; s < order.length; s += batchSize) {
    const indices = order.slice(s, s + batchSize);
    const tensor = await extractor(indices.map((i) => texts[i]), { pooling, normalize: true });
    tensor.tolist().forEach((vector, j) => out.set(vector, indices[j] * dims));
    if (performance.now() - lastPrint > 2000) {
      lastPrint = performance.now();
      const done = Math.min(s + batchSize, order.length);
      process.stdout.write(`\r  ${label}: ${done.toLocaleString()}/${texts.length.toLocaleString()}`);
    }
  }
  const secs = (performance.now() - start) / 1000;
  process.stdout.write(`\r  ${label}: ${texts.length.toLocaleString()} paragraphs in ${Math.round(secs)}s (${Math.round(texts.length / secs)}/s)\n`);
  return { vectors: out, perSecond: texts.length / secs };
}

/** First `dims` components of each `fullDims`-wide vector, re-normalized (Matryoshka truncation). */
function truncate(vectors, fullDims, dims) {
  const count = vectors.length / fullDims;
  const out = new Float32Array(count * dims);
  for (let r = 0; r < count; r++) {
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += vectors[r * fullDims + d] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) out[r * dims + d] = vectors[r * fullDims + d] / norm;
  }
  return out;
}

/**
 * Uniform scalar quantization to `bits` per value, with each dimension's
 * range calibrated on the sample (0.5th–99.5th percentile, clipped beyond).
 * Returns the de-quantized vectors — what a quantized index effectively
 * scores against — so ranking can reuse the same float dot product.
 */
function quantize(vectors, dims, bits) {
  const count = vectors.length / dims;
  const levels = 2 ** bits - 1;
  const lo = new Float32Array(dims);
  const hi = new Float32Array(dims);
  const column = new Float32Array(count);
  for (let d = 0; d < dims; d++) {
    for (let r = 0; r < count; r++) column[r] = vectors[r * dims + d];
    const sorted = Float32Array.from(column).sort();
    lo[d] = sorted[Math.floor(count * 0.005)];
    hi[d] = sorted[Math.min(count - 1, Math.floor(count * 0.995))];
  }
  const out = new Float32Array(vectors.length);
  for (let r = 0; r < count; r++) {
    for (let d = 0; d < dims; d++) {
      const span = hi[d] - lo[d] || 1;
      const clipped = Math.min(hi[d], Math.max(lo[d], vectors[r * dims + d]));
      const code = Math.round(((clipped - lo[d]) / span) * levels);
      out[r * dims + d] = lo[d] + (code / levels) * span;
    }
  }
  return out;
}

function topK(vectors, dims, query, k) {
  const count = vectors.length / dims;
  const best = []; // [score, row], kept sorted descending, length ≤ k
  for (let r = 0; r < count; r++) {
    let score = 0;
    for (let d = 0; d < dims; d++) score += vectors[r * dims + d] * query[d];
    if (best.length < k || score > best[best.length - 1][0]) {
      best.push([score, r]);
      best.sort((a, b) => b[0] - a[0]);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

function normalizedSlice(vector, dims) {
  const out = Float32Array.from(vector.slice(0, dims));
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
}

const pool = getPool();
if (!pool) {
  console.error('DATABASE_URL is not set — point it at the database (e.g. via the db tunnel) first.');
  process.exit(1);
}

let poolEnded = false;
try {
  // 1. Sample (cached): the same "{title} — {section}: {text}" the index embeds.
  let meta;
  if (fs.existsSync(metaPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    console.log(`Using cached sample of ${meta.rows.length.toLocaleString()} paragraphs (${cacheDir}).`);
  } else {
    const percent = Math.min(100, (options.sample / TOTAL_PARAGRAPHS) * 100 * 1.5);
    console.log(`Sampling ~${options.sample.toLocaleString()} paragraphs...`);
    const { rows } = await pool.query(
      `SELECT title, section, paragraph_text FROM wiki_paragraph_embeddings TABLESAMPLE SYSTEM (${percent}) REPEATABLE (11) LIMIT ${options.sample}`
    );
    meta = { rows: rows.map((r) => ({ title: r.title, section: r.section, text: r.paragraph_text })) };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }
  await pool.end();
  poolEnded = true;
  const texts = meta.rows.map((r) => `${r.title} — ${r.section}: ${r.text}`);
  const { device, dtype } = embedConfig();

  // 2. Embed the sample with both models (cached).
  const bgeExtractor = await loadExtractor(device, dtype);
  if (!fs.existsSync(vectorPath('bge'))) {
    console.log('Embedding sample with bge-small (current model)...');
    const { vectors } = await embedAll(bgeExtractor, texts, BGE_DIMS, 'mean', 'bge-small');
    fs.writeFileSync(vectorPath('bge'), Buffer.from(vectors.buffer));
  }
  console.log(`Loading ${ARCTIC_MODEL} (device: ${device}, dtype: ${dtype}; first run downloads it)...`);
  const arcticExtractor = await pipeline('feature-extraction', ARCTIC_MODEL, { device, dtype });
  if (!fs.existsSync(vectorPath('arctic'))) {
    console.log('Embedding sample with arctic-embed-m-v1.5...');
    const { vectors, perSecond } = await embedAll(arcticExtractor, texts, ARCTIC_DIMS, 'cls', 'arctic');
    fs.writeFileSync(vectorPath('arctic'), Buffer.from(vectors.buffer));
    fs.writeFileSync(path.join(cacheDir, 'arctic-speed.json'), JSON.stringify({ perSecond, device, dtype }));
  }
  const speed = JSON.parse(fs.readFileSync(path.join(cacheDir, 'arctic-speed.json'), 'utf8'));
  console.log(
    `arctic speed here: ${Math.round(speed.perSecond)} paragraphs/s (${speed.device}, ${speed.dtype}) → ` +
      `~${(TOTAL_PARAGRAPHS / speed.perSecond / 3600).toFixed(1)} h to re-embed all ${TOTAL_PARAGRAPHS.toLocaleString()} on this machine.`
  );

  // 3. Build the variants.
  const bge = readVectors('bge');
  const arctic768 = readVectors('arctic');
  const arctic256 = truncate(arctic768, ARCTIC_DIMS, 256);
  const arctic128 = truncate(arctic768, ARCTIC_DIMS, 128);
  const variants = [
    { name: 'bge-small (current)', vectors: bge, dims: BGE_DIMS, model: 'bge', prefix: false },
    { name: 'bge-small + prefix', vectors: bge, dims: BGE_DIMS, model: 'bge', prefix: true },
    { name: 'arctic-768 (full, reference)', vectors: arctic768, dims: 768, model: 'arctic', reference: true },
    { name: 'arctic-256', vectors: arctic256, dims: 256, model: 'arctic' },
    { name: 'arctic-256 8-bit', vectors: quantize(arctic256, 256, 8), dims: 256, model: 'arctic' },
    { name: 'arctic-256 4-bit', vectors: quantize(arctic256, 256, 4), dims: 256, model: 'arctic' },
    { name: 'arctic-128 4-bit', vectors: quantize(arctic128, 128, 4), dims: 128, model: 'arctic' },
  ];

  // 4. Each query through each variant.
  for (const query of options.queries) {
    console.log(`\n${'='.repeat(100)}\nQUERY: "${query}"`);
    const [bgePlain] = (await bgeExtractor([query], { pooling: 'mean', normalize: true })).tolist();
    const [bgePrefixed] = (await bgeExtractor([QUERY_PREFIX + query], { pooling: 'mean', normalize: true })).tolist();
    const [arcticQuery] = (await arcticExtractor([QUERY_PREFIX + query], { pooling: 'cls', normalize: true })).tolist();

    let referenceRows = null;
    for (const variant of variants) {
      const queryVector =
        variant.model === 'bge' ? (variant.prefix ? bgePrefixed : bgePlain) : normalizedSlice(arcticQuery, variant.dims);
      const results = topK(variant.vectors, variant.dims, queryVector, options.top);
      const rows = results.map(([, row]) => row);
      if (variant.reference) referenceRows = new Set(rows);
      const agreement =
        variant.model === 'arctic' && !variant.reference && referenceRows
          ? `  [${rows.filter((r) => referenceRows.has(r)).length}/${options.top} same as arctic-768]`
          : '';
      console.log(`\n-- ${variant.name}${agreement}`);
      for (const [score, row] of results) {
        const { title, section, text } = meta.rows[row];
        const clean = text.replace(/\s+/g, ' ').trim();
        console.log(`  [${score.toFixed(3)}] ${title} — ${section}: ${clean.length > SNIPPET_LENGTH ? `${clean.slice(0, SNIPPET_LENGTH)}…` : clean}`);
      }
    }
  }
  console.log(`\nNote: results are from a ${meta.rows.length.toLocaleString()}-paragraph sample, not the full index — compare the setups, not the absolute results.`);
} catch (error) {
  console.error(`\nFailed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  if (!poolEnded) await pool.end().catch(() => {});
}
