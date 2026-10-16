#!/usr/bin/env node
/**
 * Times one vector search end to end, through the exact code path the site
 * uses (embedText → searchSimilarArticles), and prints what it found. For
 * seeing search latency for yourself: the first repeat is usually "cold"
 * (index pages read from Postgres's disk), later repeats "warm" (the same
 * pages now cached in RAM).
 *
 * Usage: node wiki_searcher/scripts/search.js "<query>" [--probes N] [--top N] [--repeat N]
 *   --probes  ivfflat clusters scanned per search (default: utils/vectorIndex.js's default)
 *   --top     distinct articles to return (default 5)
 *   --repeat  times to run the same search (default 2: cold, then warm)
 *
 * Run wherever DATABASE_URL points at the database (e.g. through the db
 * tunnel); the printed tunnel round trip shows how much of each search time
 * is just network.
 */
import { loadEnv } from '../../imright/load-env.js';

loadEnv();
// Must be set before db.js creates its pool: time slow searches instead of
// cancelling them at the server's usual 30s.
process.env.DB_STATEMENT_TIMEOUT_MS ??= '0';

const { getPool } = await import('../../imright/scripts/db.js');
const { embedText } = await import('../textEmbeddings.js');
const { searchSimilarArticles } = await import('../../utils/vectorIndex.js');
const { default: pgvector } = await import('pgvector/pg');

const SNIPPET_LENGTH = 200;

function parseArgs(argv) {
  const options = { query: null, probes: null, top: 5, repeat: 2 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--probes') options.probes = Number(argv[++i]);
    else if (arg === '--top') options.top = Number(argv[++i]);
    else if (arg === '--repeat') options.repeat = Number(argv[++i]);
    else if (!options.query) options.query = arg;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.query || [options.top, options.repeat].some((n) => !Number.isInteger(n) || n < 1) || (options.probes !== null && !(options.probes >= 1))) {
  console.error('Usage: node wiki_searcher/scripts/search.js "<query>" [--probes N] [--top N] [--repeat N]');
  process.exit(1);
}
if (options.probes !== null) process.env.VECTOR_SEARCH_PROBES = String(options.probes); // read per call by searchSimilarArticles

const pool = getPool();
if (!pool) {
  console.error('DATABASE_URL is not set — point it at the database (e.g. via the db tunnel) first.');
  process.exit(1);
}

const ms = (start) => Math.round(performance.now() - start);

try {
  let start = performance.now();
  await embedText('warm-up'); // loads the model once, so it isn't counted as query time
  console.log(`Model load:        ${ms(start)} ms (one-time per process)`);

  start = performance.now();
  const embedding = await embedText(options.query);
  console.log(`Embed query:       ${ms(start)} ms`);

  start = performance.now();
  await pool.query('SELECT 1');
  console.log(`DB round trip:     ${ms(start)} ms (network/tunnel overhead included in each search below)`);

  console.log(`\nSearching "${options.query}" (probes = ${process.env.VECTOR_SEARCH_PROBES || 'default'}, top ${options.top}):`);
  let matches = [];
  for (let i = 1; i <= options.repeat; i++) {
    start = performance.now();
    matches = await searchSimilarArticles(embedding, options.top);
    console.log(`  search #${i}: ${ms(start)} ms${i === 1 ? ' (likely cold: index read from disk)' : ''}`);
  }

  console.log('\nResults:');
  if (matches.length === 0) console.log('  (none)');
  for (const match of matches) {
    console.log(`  [${Number(match.score).toFixed(3)}] ${match.title}`);
    const { rows } = await pool.query(
      'SELECT section, paragraph_text FROM wiki_paragraph_embeddings WHERE title = $1 ORDER BY embedding <=> $2 LIMIT 1',
      [match.title, pgvector.toSql(embedding)]
    );
    if (rows[0]) {
      const text = rows[0].paragraph_text.replace(/\s+/g, ' ').trim();
      console.log(`      (${rows[0].section}) "${text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text}"`);
    }
  }
} catch (error) {
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
