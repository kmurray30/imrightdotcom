/**
 * pgvector-backed paragraph index: finds candidate Wikipedia articles for a
 * search query by semantic similarity, replacing MediaWiki's rate-limited
 * generator=search for the 'wikimedia' provider. See
 * wiki_searcher/schema/wiki_paragraph_embeddings.sql for the table this
 * queries, and wiki_searcher/embeddingIndex.js for how it's populated.
 */
import { getPool } from '../imright/scripts/db.js';
import pgvector from 'pgvector/pg';

// Over-fetch at paragraph granularity, then dedupe to distinct articles in
// JS — simpler and fast enough at this scale than a GROUP BY over an ANN scan.
const OVERFETCH_FACTOR = 10;

// How many of the ivfflat index's clusters each search scans. pgvector's
// default is 1, which misses most good matches; ≈ sqrt(lists) is its
// suggested starting point (create-ann-index.js prints the value for the
// index it built). Higher = better recall, slower queries. 69 ≈ sqrt(4787),
// the lists the full English Wikipedia index (~22.9M paragraphs) gets.
const DEFAULT_PROBES = 69;

/**
 * @param {number[]} embedding
 * @param {number} [topK] - Number of distinct articles to return.
 * @returns {Promise<Array<{ title: string, score: number }>>} Best-matching paragraph's score per article, best first.
 */
export async function searchSimilarArticles(embedding, topK = 5) {
  const pool = getPool();
  if (!pool) {
    throw new Error('DATABASE_URL is not set; cannot query the wiki paragraph vector index.');
  }
  const probes = Math.max(1, Math.floor(Number(process.env.VECTOR_SEARCH_PROBES) || DEFAULT_PROBES));

  // SET LOCAL inside a transaction, on one checked-out client, so the probes
  // setting applies to this query only and never leaks to other queries that
  // later reuse this pooled connection.
  const client = await pool.connect();
  // pg-pool drops its own error listener while a client is checked out; without
  // one, a dropped connection here would crash the process instead of
  // rejecting the query. Removed again before release so listeners don't pile up.
  const onClientError = () => {};
  client.on('error', onClientError);
  let rows;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ivfflat.probes = ${probes}`);
    ({ rows } = await client.query(
      `SELECT title, 1 - (embedding <=> $1) AS score
       FROM wiki_paragraph_embeddings
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [pgvector.toSql(embedding), topK * OVERFETCH_FACTOR]
    ));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }

  const seenTitles = new Set();
  const distinctArticles = [];
  for (const row of rows) {
    if (seenTitles.has(row.title)) continue;
    seenTitles.add(row.title);
    distinctArticles.push({ title: row.title, score: row.score });
    if (distinctArticles.length >= topK) break;
  }
  return distinctArticles;
}
