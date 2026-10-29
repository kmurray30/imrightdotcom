#!/usr/bin/env node
/**
 * Checks the cited-span index before the site uses it. Read-only.
 *
 * 1. Vectors: re-embeds a random sample of stored spans exactly as the build
 *    did ("{title} — {section}: {text}", arctic, 256 dims) and compares them
 *    with the stored halfvec (cosine should be ≥ 0.999).
 * 2. Search: for a set of test queries, a reference top-10 against what the
 *    index search (wiki_searcher/spanSearch.js: bit-quantized ivfflat, then
 *    exact re-rank) returns at a few probes / candidates settings: recall@10
 *    and time per query. Also prints the top matches for a few queries.
 *    The reference is the same search made exhaustive (every list, 20,000
 *    Hamming candidates re-ranked exactly), about a minute per query; with
 *    --exact it is a true full scan of the table instead (exact, but ~10
 *    minutes per query on Railway's disk).
 *
 * Needs wiki_citation_spans_ann (create-ann-index.js --spans) for step 2.
 *
 * Usage: node wiki_searcher/scripts/check-span-search.js [--vectors-only] [--exact] [--queries N]
 */
import { loadEnv } from '../../imright/load-env.js';

loadEnv();
process.env.DB_STATEMENT_TIMEOUT_MS ??= '0'; // the exact scans take minutes
const { getPool } = await import('../../imright/scripts/db.js');
const { embedPassages, embedQueries, ARCTIC_DIMS } = await import('../arcticEmbeddings.js');

const args = process.argv.slice(2);
const vectorsOnly = args.includes('--vectors-only');
const trueExact = args.includes('--exact');
const queryCount = Number(args[args.indexOf('--queries') + 1]) || 16;
const SAMPLE = 20;
const K = 10;
const SETTINGS = [
  { probes: 30, candidates: 200 },
  { probes: 63, candidates: 400 },
  { probes: 100, candidates: 800 },
  { probes: 160, candidates: 1500 },
  // Which step loses matches: every list with the usual pool, or the usual lists with a big pool.
  { probes: 4000, candidates: 400 },
  { probes: 63, candidates: 3000 },
];
const QUERIES = [
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
].slice(0, queryCount);
const SHOWN = ['TAS2R38', 'goitrogens in broccoli', 'passengers of the Titanic who died'];

const pool = getPool();
if (!pool) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const literal = (vector) => `[${Array.from(vector).join(',')}]`;
const parseVector = (text) => text.slice(1, -1).split(',').map(Number);
const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
};

// 1. Stored vectors match a fresh embedding.
console.log(`1. Re-embedding ${SAMPLE} random spans and comparing with the stored vectors...`);
const { rows: sample } = await pool.query(
  `SELECT title, section, span_text, embedding::text AS embedding FROM wiki_citation_spans TABLESAMPLE SYSTEM (0.001) LIMIT ${SAMPLE}`
);
const fresh = await embedPassages(sample.map((row) => `${row.title} — ${row.section}: ${row.span_text}`));
const sims = sample.map((row, i) => cosine(parseVector(row.embedding), fresh[i]));
const minSim = Math.min(...sims);
console.log(`   cosine(stored, fresh): min ${minSim.toFixed(5)}, mean ${(sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(5)} over ${sims.length} spans → ${minSim >= 0.999 ? 'OK' : 'MISMATCH'}`);
if (vectorsOnly) {
  await pool.end();
  process.exit(minSim >= 0.999 ? 0 : 1);
}

// 2. Index search vs exact search.
const { rows: [ann] } = await pool.query(`SELECT to_regclass('wiki_citation_spans_ann') AS name`);
if (!ann.name) {
  console.error('\nwiki_citation_spans_ann does not exist yet: run create-ann-index.js --spans first.');
  await pool.end();
  process.exit(1);
}
console.log(
  `\n2. Reference top-${K} for ${QUERIES.length} queries (` +
    (trueExact ? 'a full table scan each, ~10 minutes per query' : 'every list, 20,000 candidates re-ranked; about a minute per query') +
    ')...'
);
const vectors = await embedQueries(QUERIES);
const exact = [];
for (let i = 0; i < QUERIES.length; i++) {
  const start = performance.now();
  if (!trueExact) {
    exact.push(await indexSearch(vectors[i], { probes: 4000, candidates: 20000, workMem: '1GB' }));
    console.log(`   ${i + 1}/${QUERIES.length} "${QUERIES[i]}" (${((performance.now() - start) / 1000).toFixed(0)} s)`);
    continue;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL max_parallel_workers_per_gather = 8');
    await client.query('SET LOCAL enable_indexscan = off'); // a true scan, not the index's approximation
    const { rows } = await client.query(
      `SELECT id, 1 - (embedding <=> $1::halfvec(${ARCTIC_DIMS})) AS score FROM wiki_citation_spans ORDER BY embedding <=> $1::halfvec(${ARCTIC_DIMS}) LIMIT ${K}`,
      [literal(vectors[i])]
    );
    await client.query('COMMIT');
    exact.push(rows.map((row) => ({ id: String(row.id), score: Number(row.score) })));
    console.log(`   ${i + 1}/${QUERIES.length} "${QUERIES[i]}" (${((performance.now() - start) / 1000).toFixed(0)} s)`);
  } finally {
    client.release();
  }
}

// The same SQL as spanSearch.js, returning ids, so results can be matched to the reference ones.
async function indexSearch(vector, { probes, candidates, workMem = '128MB' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ivfflat.probes = ${probes}`);
    await client.query(`SET LOCAL work_mem = '${workMem}'`); // 128MB as spanSearch.js
    const { rows } = await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT id, embedding FROM wiki_citation_spans
         ORDER BY binary_quantize(embedding)::bit(${ARCTIC_DIMS}) <~> binary_quantize($1::halfvec(${ARCTIC_DIMS}))
         LIMIT $2
       )
       SELECT id, 1 - (embedding <=> $1::halfvec(${ARCTIC_DIMS})) AS score FROM candidates ORDER BY embedding <=> $1::halfvec(${ARCTIC_DIMS}) LIMIT ${K}`,
      [literal(vector), candidates]
    );
    await client.query('COMMIT');
    return rows.map((row) => ({ id: String(row.id), score: Number(row.score) }));
  } finally {
    client.release();
  }
}

const meanScore = (rows) => rows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, rows.length);
const bySetting = new Map();
console.log(`\n   recall@${K}, similarity lost (reference top-${K} mean minus this setting's), and time per query:`);
for (const setting of SETTINGS) {
  let found = 0;
  let lost = 0;
  const times = [];
  const results = [];
  for (let i = 0; i < QUERIES.length; i++) {
    const start = performance.now();
    const rows = await indexSearch(vectors[i], setting);
    times.push(performance.now() - start);
    results.push(rows);
    const reference = new Set(exact[i].map((row) => row.id));
    found += rows.filter((row) => reference.has(row.id)).length;
    lost += meanScore(exact[i]) - meanScore(rows);
  }
  bySetting.set(`${setting.probes}/${setting.candidates}`, results);
  times.sort((a, b) => a - b);
  console.log(
    `   probes ${String(setting.probes).padStart(4)}, candidates ${String(setting.candidates).padStart(4)}: recall ${(found / (QUERIES.length * K)).toFixed(3)}` +
      ` · similarity lost ${(lost / QUERIES.length).toFixed(4)} · median ${times[Math.floor(times.length / 2)].toFixed(0)} ms, max ${times[times.length - 1].toFixed(0)} ms`
  );
}
console.log(`   (reference top-${K} mean similarity, averaged over queries: ${(exact.reduce((sum, rows) => sum + meanScore(rows), 0) / exact.length).toFixed(4)})`);

async function describe(rows) {
  if (!rows.length) return [];
  const { rows: spans } = await pool.query(`SELECT id::text AS id, title, left(span_text, 100) AS text FROM wiki_citation_spans WHERE id = ANY($1::bigint[])`, [rows.map((row) => row.id)]);
  const byId = new Map(spans.map((span) => [span.id, span]));
  return rows.map((row) => `${row.score.toFixed(3)}  ${byId.get(row.id)?.title} — ${(byId.get(row.id)?.text ?? '').replace(/\s+/g, ' ')}…`);
}
console.log('\n   Top 3 at the defaults (63/400) vs the reference, for a few queries:');
for (const query of SHOWN) {
  const i = QUERIES.indexOf(query);
  if (i === -1) continue;
  console.log(`   "${query}"`);
  for (const line of await describe(bySetting.get('63/400')[i].slice(0, 3))) console.log(`     default    ${line}`);
  for (const line of await describe(exact[i].slice(0, 3))) console.log(`     reference  ${line}`);
}

await pool.end();
