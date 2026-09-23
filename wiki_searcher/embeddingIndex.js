/**
 * Shared logic for populating wiki_paragraph_embeddings — used by the
 * one-time full build (scripts/build-index-from-wikimedia.js, or
 * scripts/build-index-from-ndjson.js for an NDJSON file you already have)
 * and the daily refresh (scripts/refresh-daily.js), so there's exactly one
 * place that decides how an article's wikitext becomes indexed paragraphs.
 *
 * Every paragraph above a bare length floor is indexed — not just ones
 * adjacent to a citation. An earlier version filtered to citation-adjacent
 * paragraphs only, on the theory that an uncited paragraph isn't something
 * ref_extractor could ever cite anyway. That reasoning doesn't hold up for
 * what this index is actually for: it only decides which ARTICLES surface
 * as search candidates for a query (providers/wikimedia.js) — ref_extractor
 * re-parses the full article's wikitext for real citations afterward,
 * completely independent of what did or didn't get embedded here. So
 * filtering by citation here bought nothing downstream, while actively
 * costing recall: a query's only textual match inside an article might sit
 * in an uncited paragraph (or one cited by a source type outside the
 * allowed list), and filtering it out could mean that article never
 * surfaces as a candidate at all. Given the priority here is recall —
 * finding an article if the corpus has ANYTHING relevant, false positives
 * being far cheaper than false negatives — indexing everything and letting
 * embedding similarity (plus ref_extractor's later, real citation check)
 * sort out precision is the better tradeoff.
 *
 * Each paragraph is embedded with a "{title} — {section}: " prefix, so the
 * embedding model has enough context to resolve bare pronouns ("he killed
 * his father") — the cheap "contextual chunking" fix, not the
 * LLM-generated-summary version. The prefix is embedding-only; the stored
 * paragraph_text is the plain paragraph, since that's what a human or
 * downstream LLM would want to see, not the search-time prefix.
 */
import { getPool } from '../imright/scripts/db.js';
import { embedText } from './textEmbeddings.js';
import { stripWikiMarkup } from '../ref_extractor/parser/index.js';
import pgvector from 'pgvector/pg';

const MIN_PARAGRAPH_LENGTH = 30;

/** Same section-splitting regex used in ref_extractor/searchThenExtract.js and parser/index.js's parseRefs. */
function buildSections(source) {
  const sections = [];
  const headerRegex = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/gm;
  let lastEnd = 0;
  let prevName = 'Introduction';
  let match;

  while ((match = headerRegex.exec(source)) !== null) {
    const content = source.slice(lastEnd, match.index);
    if (content.trim()) {
      sections.push({ name: prevName, content });
    }
    prevName = match[2].trim();
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < source.length) {
    sections.push({ name: prevName, content: source.slice(lastEnd) });
  }
  return sections;
}

/** Paragraphs within one section — the unit this index stores and embeds. */
function splitParagraphs(sectionContent) {
  return sectionContent.split(/\n\n+/).filter((part) => part.trim().length >= MIN_PARAGRAPH_LENGTH);
}

/**
 * Splits an article's wikitext into paragraphs, cleaned of wiki markup and
 * ref tags. Every paragraph above the length floor is included — see the
 * file header for why this isn't filtered down to citation-adjacent ones.
 * @returns {Array<{ section: string, text: string }>}
 */
function extractParagraphs(wikitext) {
  const sections = buildSections(wikitext);
  const results = [];

  for (const section of sections) {
    for (const paragraphText of splitParagraphs(section.content)) {
      const cleaned = stripWikiMarkup(paragraphText.replace(/<ref[\s\S]*?<\/ref\s*>|<ref[^>]*\/\s*>/gi, ''));
      if (cleaned.length >= MIN_PARAGRAPH_LENGTH) {
        results.push({ section: section.name, text: cleaned });
      }
    }
  }
  return results;
}

/** True if this article's stored embeddings are already current — skips re-embedding on a re-run. */
async function isAlreadyCurrent(client, title, versionIdentifier) {
  if (versionIdentifier == null) return false;
  const { rows } = await client.query(
    'SELECT version_identifier FROM wiki_paragraph_embeddings WHERE title = $1 LIMIT 1',
    [title]
  );
  return rows.length > 0 && rows[0].version_identifier === versionIdentifier;
}

/**
 * Embeds and upserts an article's paragraphs. Replaces all of that article's
 * existing rows, so a shrinking article (fewer/shorter paragraphs than
 * before) doesn't leave stale ones behind. Resumable: a second call with the
 * same versionIdentifier is a no-op.
 *
 * title is the only key search actually uses at fetch time (see
 * providers/wikimedia.js) — Wikimedia's On-demand API has no ID-based lookup,
 * only /v2/articles/{title}. But title alone can't survive a page rename: the
 * old title would keep its embedded rows forever, quietly dead (they'd never
 * again resolve via On-demand, since the article now lives under a different
 * title). pageId (Wikimedia's article.identifier, stable across renames) is
 * what closes that gap — when provided, any other row sharing this pageId
 * under a *different* title is deleted before writing this one, so a rename
 * cleans up its old title's rows instead of leaving them to rot.
 *
 * @param {object} article - { title, wikitext, versionIdentifier, pageId }
 * @returns {Promise<{ title: string, paragraphCount: number, skipped: boolean }>}
 */
export async function upsertArticleEmbeddings({ title, wikitext, versionIdentifier, pageId }) {
  const pool = getPool();
  if (!pool) {
    throw new Error('DATABASE_URL is not set; cannot write to the wiki paragraph vector index.');
  }

  const client = await pool.connect();
  try {
    if (await isAlreadyCurrent(client, title, versionIdentifier)) {
      return { title, paragraphCount: 0, skipped: true };
    }

    const paragraphs = extractParagraphs(wikitext ?? '');

    await client.query('BEGIN');
    if (pageId != null) {
      await client.query('DELETE FROM wiki_paragraph_embeddings WHERE page_id = $1 AND title != $2', [pageId, title]);
    }
    await client.query('DELETE FROM wiki_paragraph_embeddings WHERE title = $1', [title]);

    for (let index = 0; index < paragraphs.length; index++) {
      const { section, text } = paragraphs[index];
      const embedding = await embedText(`${title} — ${section}: ${text}`);
      await client.query(
        `INSERT INTO wiki_paragraph_embeddings (title, page_id, paragraph_index, section, paragraph_text, embedding, version_identifier)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [title, pageId ?? null, index, section, text, pgvector.toSql(embedding), versionIdentifier ?? null]
      );
    }
    await client.query('COMMIT');
    return { title, paragraphCount: paragraphs.length, skipped: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
