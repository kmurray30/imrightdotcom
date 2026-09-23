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

  const vectorLiteral = pgvector.toSql(embedding);
  const { rows } = await pool.query(
    `SELECT title, 1 - (embedding <=> $1) AS score
     FROM wiki_paragraph_embeddings
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [vectorLiteral, topK * OVERFETCH_FACTOR]
  );

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
