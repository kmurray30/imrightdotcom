#!/usr/bin/env node
/**
 * Builds the vector search index (ivfflat) on wiki_paragraph_embeddings. Run
 * once AFTER the table is fully loaded (build-index-from-wikimedia.js), and
 * again only if the data changes a lot. ivfflat computes its cluster centers
 * from the rows present at build time, so an index created on an empty or
 * half-loaded table searches badly no matter how much data arrives later —
 * which is exactly what the schema file used to do.
 *
 * Also drops wiki_paragraph_embeddings_title if present: UNIQUE (title,
 * paragraph_index) already provides an index with title as its leading
 * column, which serves every title lookup, so the separate index only cost
 * disk and write time.
 *
 * Safe to re-run: if a usable index already exists (i.e. not the original
 * empty-table one), it's left alone unless --rebuild is passed. If the
 * connection drops mid-build, the build keeps running on the server; re-run
 * this to see whether it's still going or finished.
 *
 * Uses its own connections with no statement timeout (the shared pool's 30s
 * limit would kill the build). Prints progress every 30s.
 *
 * Usage: node wiki_searcher/scripts/create-ann-index.js [--rebuild]
 *   MAINTENANCE_WORK_MEM (default 2GB), PARALLEL_WORKERS (default 8)
 */
import pg from 'pg';
import { loadEnv } from '../../imright/load-env.js';
import { shouldUseSsl } from '../../imright/scripts/db.js';

loadEnv();

const INDEX_NAME = 'wiki_paragraph_embeddings_ann';
const EMPTY_TABLE_INDEX_LISTS = 200; // what the schema file used to create on the empty table
const rebuild = process.argv.includes('--rebuild');
const maintenanceWorkMem = process.env.MAINTENANCE_WORK_MEM || '2GB';
const parallelWorkers = Number(process.env.PARALLEL_WORKERS) || 8;

if (!/^\d+\s*(kB|MB|GB)$/.test(maintenanceWorkMem)) {
  console.error(`MAINTENANCE_WORK_MEM must look like "2GB" or "512MB" (got "${maintenanceWorkMem}").`);
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set — point it at the database (e.g. via the db tunnel) and re-run.');
  process.exit(1);
}

const ssl = shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false;
const client = new pg.Client({ connectionString, ssl });
const monitor = new pg.Client({ connectionString, ssl });
for (const c of [client, monitor]) c.on('error', (err) => console.error(`[db] connection error: ${err.message}`));
await client.connect();
await monitor.connect();

async function buildInProgress() {
  const { rows } = await monitor.query(
    `SELECT phase, blocks_done, blocks_total, tuples_done, tuples_total
     FROM pg_stat_progress_create_index WHERE relid = 'wiki_paragraph_embeddings'::regclass LIMIT 1`
  );
  return rows[0] ?? null;
}

function describeProgress(p) {
  const pct = (done, total) => ((100 * Number(done)) / Number(total)).toFixed(1);
  if (Number(p.tuples_total) > 0) return `${p.phase} — ${pct(p.tuples_done, p.tuples_total)}% of rows`;
  if (Number(p.blocks_total) > 0) return `${p.phase} — ${pct(p.blocks_done, p.blocks_total)}% of blocks`;
  return p.phase;
}

try {
  const running = await buildInProgress();
  if (running) {
    console.log(`An index build is already running on the server (${describeProgress(running)}). Re-run this later to check on it.`);
    process.exit(0);
  }

  const { rows: existing } = await client.query(
    `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
    [INDEX_NAME]
  );
  const current = existing[0];
  const isEmptyTableIndex = current && current.def.includes(`lists='${EMPTY_TABLE_INDEX_LISTS}'`);
  if (current && current.valid && !isEmptyTableIndex && !rebuild) {
    console.log(`A usable ${INDEX_NAME} already exists:\n  ${current.def}\nNothing to do (pass --rebuild to build it again).`);
    process.exit(0);
  }

  // pgvector's guidance: lists = rows / 1000 up to 1M rows, sqrt(rows) beyond;
  // probes ≈ sqrt(lists) as a starting point for query-time recall.
  const { rows: [{ n }] } = await client.query('SELECT count(*)::bigint AS n FROM wiki_paragraph_embeddings');
  const rowCount = Number(n);
  const lists = Math.max(10, Math.round(rowCount <= 1_000_000 ? rowCount / 1000 : Math.sqrt(rowCount)));
  const probes = Math.max(1, Math.round(Math.sqrt(lists)));
  console.log(`${rowCount.toLocaleString()} rows → lists = ${lists}`);

  await client.query('SET statement_timeout = 0');
  await client.query(`SET maintenance_work_mem = '${maintenanceWorkMem}'`);
  await client.query(`SET max_parallel_maintenance_workers = ${parallelWorkers}`);

  console.log(`Dropping ${current ? (isEmptyTableIndex ? 'the empty-table ANN index' : 'the existing ANN index') : 'no ANN index (none found)'} and the redundant title index...`);
  await client.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await client.query('DROP INDEX IF EXISTS wiki_paragraph_embeddings_title');

  const startedAt = Date.now();
  const elapsed = () => `${Math.round((Date.now() - startedAt) / 60000)} min`;
  const progressTimer = setInterval(async () => {
    try {
      const p = await buildInProgress();
      if (p) console.log(`  [${elapsed()}] ${describeProgress(p)}`);
    } catch {
      // progress is best-effort; the build itself is what matters
    }
  }, 30_000);

  console.log(`Building ivfflat index with lists = ${lists} (${parallelWorkers} parallel workers, maintenance_work_mem ${maintenanceWorkMem}) — this can take a while...`);
  try {
    await client.query(
      `CREATE INDEX ${INDEX_NAME} ON wiki_paragraph_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${lists})`
    );
  } finally {
    clearInterval(progressTimer);
  }
  await client.query('ANALYZE wiki_paragraph_embeddings');

  const { rows: [{ size }] } = await client.query(`SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS size`, [INDEX_NAME]);
  console.log(`\nDone in ${elapsed()}. Index size: ${size}.`);
  console.log(`Query-time recall setting: VECTOR_SEARCH_PROBES=${probes} (≈ sqrt(lists); utils/vectorIndex.js's default).`);
} catch (error) {
  console.error(`\nFailed: ${error.message}`);
  console.error('If the connection dropped, the build may still be running on the server — re-run this script to check.');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  await monitor.end().catch(() => {});
}
