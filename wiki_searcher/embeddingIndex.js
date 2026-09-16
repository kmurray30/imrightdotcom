/**
 * Shared logic for populating wiki_paragraph_embeddings — used by both the
 * one-time full build (scripts/build-index-from-snapshot.js) and the daily
 * refresh (scripts/refresh-daily.js), so there's exactly one place that
 * decides how an article's wikitext becomes indexed paragraphs.
 */
import { getPool } from '../imright/scripts/db.js';
import { embedText } from '../utils/embeddings.js';
import pgvector from 'pgvector/pg';

const MIN_PARAGRAPH_LENGTH = 20;

/** Same paragraph splitting as ref_extractor/searchThenExtract.js, minus the source-offset tracking it needs and this doesn't. */
function splitParagraphs(wikitext) {
  return wikitext
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= MIN_PARAGRAPH_LENGTH);
}

/**
 * Embeds and upserts every paragraph of one article. Replaces all of that
 * article's existing rows, so a shrinking article doesn't leave stale
 * trailing paragraphs behind.
 *
 * @param {object} article - { title, wikitext, versionIdentifier }
 */
export async function upsertArticleEmbeddings({ title, wikitext, versionIdentifier }) {
  const pool = getPool();
  if (!pool) {
    throw new Error('DATABASE_URL is not set; cannot write to the wiki paragraph vector index.');
  }

  const paragraphs = splitParagraphs(wikitext ?? '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM wiki_paragraph_embeddings WHERE title = $1', [title]);

    for (let index = 0; index < paragraphs.length; index++) {
      const embedding = await embedText(paragraphs[index]);
      await client.query(
        `INSERT INTO wiki_paragraph_embeddings (title, paragraph_index, paragraph_text, embedding, version_identifier)
         VALUES ($1, $2, $3, $4, $5)`,
        [title, index, paragraphs[index], pgvector.toSql(embedding), versionIdentifier ?? null]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { title, paragraphCount: paragraphs.length };
}
