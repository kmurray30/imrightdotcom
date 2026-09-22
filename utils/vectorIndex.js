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
 * One phase of the search below: nearest paragraphs among either the cited
 * or the uncited half of the index (never both — see searchSimilarArticles).
 * `hasCitation` is spliced into the SQL as a literal, not bound as a
 * parameter, so the WHERE clause matches one of the two partial indexes
 * (wiki_paragraph_embeddings_ann_cited/_uncited) verbatim — confirmed via
 * EXPLAIN that this is what makes the planner pick the matching partial
 * index instead of scanning/filtering the whole table.
 */
async function queryByCitation(pool, vectorLiteral, hasCitation, limit, excludeTitles) {
  if (limit <= 0) return [];
  const params = [vectorLiteral];
  let excludeClause = '';
  if (excludeTitles.length > 0) {
    params.push(excludeTitles);
    excludeClause = `AND title != ALL($${params.length}::text[])`;
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT title, 1 - (embedding <=> $1) AS score
     FROM wiki_paragraph_embeddings
     WHERE has_citation = ${hasCitation} ${excludeClause}
     ORDER BY embedding <=> $1
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Cited paragraphs are searched first and fill the result up to topK; only
 * if there aren't enough cited matches does a second pass over uncited
 * paragraphs fill the remaining slots. This is deliberate, not just an
 * optimization: every result here occupies one of a caller's fixed top-N
 * search-candidate budget, and ref_extractor can only ever pull a real
 * citation from an article if the corpus actually has one — so a cited
 * match is strictly more likely to be worth its slot than an uncited one.
 * Falling back to uncited matches (rather than excluding them outright)
 * still means a topic with zero citable coverage anywhere isn't invisible —
 * see wiki_searcher/embeddingIndex.js for the fuller reasoning.
 *
 * @param {number[]} embedding
 * @param {number} [topK] - Number of distinct articles to return.
 * @returns {Promise<Array<{ title: string, score: number }>>} Best-matching paragraph's score per article, cited matches first, best-scored first within each group.
 */
export async function searchSimilarArticles(embedding, topK = 5) {
  const pool = getPool();
  if (!pool) {
    throw new Error('DATABASE_URL is not set; cannot query the wiki paragraph vector index.');
  }

  const vectorLiteral = pgvector.toSql(embedding);
  const seenTitles = new Set();
  const distinctArticles = [];

  const addDistinct = (rows) => {
    for (const row of rows) {
      if (seenTitles.has(row.title)) continue;
      seenTitles.add(row.title);
      distinctArticles.push({ title: row.title, score: row.score });
      if (distinctArticles.length >= topK) return;
    }
  };

  addDistinct(await queryByCitation(pool, vectorLiteral, true, topK * OVERFETCH_FACTOR, []));

  if (distinctArticles.length < topK) {
    const remaining = topK - distinctArticles.length;
    addDistinct(
      await queryByCitation(pool, vectorLiteral, false, remaining * OVERFETCH_FACTOR, Array.from(seenTitles))
    );
  }

  return distinctArticles;
}
