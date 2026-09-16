/**
 * Shared logic for populating wiki_paragraph_embeddings — used by both the
 * one-time full build (scripts/build-index-from-snapshot.js) and the daily
 * refresh (scripts/refresh-daily.js), so there's exactly one place that
 * decides how an article's wikitext becomes indexed paragraphs.
 *
 * Two design decisions, both from the chunking discussion this came out of:
 *
 * 1. Only paragraphs adjacent to a valid citation are indexed. A paragraph
 *    with no citation isn't something ref_extractor could ever cite anyway,
 *    so indexing it just adds noise and cost. Reuses ref_extractor's own
 *    ref-finding/cite-parsing (findAllRefs, parseAllCiteTemplates) and its
 *    citation_types config, rather than re-deciding what counts as a
 *    citable source in a second place.
 *
 * 2. Each paragraph is embedded with a "{title} — {section}: " prefix, so
 *    the embedding model has enough context to resolve bare pronouns
 *    ("he killed his father") — the cheap "contextual chunking" fix, not
 *    the LLM-generated-summary version. The prefix is embedding-only; the
 *    stored paragraph_text is the plain paragraph, since that's what a
 *    human or downstream LLM would want to see, not the search-time prefix.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { getPool } from '../imright/scripts/db.js';
import { embedText } from '../utils/embeddings.js';
import { findAllRefs, stripWikiMarkup } from '../ref_extractor/parser/index.js';
import { parseAllCiteTemplates } from '../ref_extractor/parser/citeTemplate.js';
import pgvector from 'pgvector/pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIN_PARAGRAPH_LENGTH = 30;

// Reuses ref_extractor's own definition of "citable source" rather than
// re-deciding it here — see ref_extractor/config.yaml.
const refExtractorConfigPath = path.join(__dirname, '..', 'ref_extractor', 'config.yaml');
const refExtractorConfig = fs.existsSync(refExtractorConfigPath)
  ? yaml.parse(fs.readFileSync(refExtractorConfigPath, 'utf8'))
  : {};
const CITATION_TYPES = new Set(
  (refExtractorConfig.citation_types ?? ['web', 'news', 'journal', 'magazine']).map((t) => t.toLowerCase())
);

/** Same section-splitting regex used in ref_extractor/searchThenExtract.js and parser/index.js's parseRefs. */
function buildSectionsWithRanges(source) {
  const sections = [];
  const headerRegex = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/gm;
  let lastEnd = 0;
  let prevName = 'Introduction';
  let match;

  while ((match = headerRegex.exec(source)) !== null) {
    const headerEnd = match.index + match[0].length;
    const content = source.slice(lastEnd, match.index);
    if (content.trim()) {
      sections.push({ name: prevName, content, start: lastEnd, end: match.index });
    }
    prevName = match[2].trim();
    lastEnd = headerEnd;
  }
  if (lastEnd < source.length) {
    sections.push({ name: prevName, content: source.slice(lastEnd), start: lastEnd, end: source.length });
  }
  return sections;
}

/** Paragraphs within one section, with source-relative [start, end) offsets for ref-overlap checks. */
function splitParagraphsWithRanges(sectionContent, sectionStart) {
  const paragraphs = [];
  const parts = sectionContent.split(/\n\n+/);
  let offset = 0;
  for (const part of parts) {
    const start = sectionStart + offset;
    const end = start + part.length;
    offset += part.length + 2;
    if (part.trim().length >= MIN_PARAGRAPH_LENGTH) {
      paragraphs.push({ text: part, start, end });
    }
  }
  return paragraphs;
}

/** True if any ref overlapping this paragraph parses to at least one allowed, well-formed citation. */
function hasValidCitation(paragraph, refs) {
  const overlapping = refs.filter((ref) => ref.start < paragraph.end && ref.end > paragraph.start);
  for (const ref of overlapping) {
    const parsedList = parseAllCiteTemplates(ref.content ?? '');
    for (const parsed of parsedList) {
      if (CITATION_TYPES.has(parsed.type?.toLowerCase()) && parsed.url?.startsWith('http')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Splits an article's wikitext into citation-adjacent paragraphs, cleaned of
 * wiki markup and ref tags — the unit this index stores and embeds.
 * @returns {Array<{ section: string, text: string }>}
 */
function extractCitableParagraphs(wikitext) {
  const refs = findAllRefs(wikitext);
  const sections = buildSectionsWithRanges(wikitext);
  const results = [];

  for (const section of sections) {
    for (const paragraph of splitParagraphsWithRanges(section.content, section.start)) {
      if (!hasValidCitation(paragraph, refs)) continue;
      const cleaned = stripWikiMarkup(paragraph.text.replace(/<ref[\s\S]*?<\/ref\s*>|<ref[^>]*\/\s*>/gi, ''));
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
 * Embeds and upserts an article's citation-adjacent paragraphs. Replaces all
 * of that article's existing rows, so a shrinking article (fewer citable
 * paragraphs than before) doesn't leave stale ones behind. Resumable: a
 * second call with the same versionIdentifier is a no-op.
 *
 * @param {object} article - { title, wikitext, versionIdentifier }
 * @returns {Promise<{ title: string, paragraphCount: number, skipped: boolean }>}
 */
export async function upsertArticleEmbeddings({ title, wikitext, versionIdentifier }) {
  const pool = getPool();
  if (!pool) {
    throw new Error('DATABASE_URL is not set; cannot write to the wiki paragraph vector index.');
  }

  const client = await pool.connect();
  try {
    if (await isAlreadyCurrent(client, title, versionIdentifier)) {
      return { title, paragraphCount: 0, skipped: true };
    }

    const paragraphs = extractCitableParagraphs(wikitext ?? '');

    await client.query('BEGIN');
    await client.query('DELETE FROM wiki_paragraph_embeddings WHERE title = $1', [title]);

    for (let index = 0; index < paragraphs.length; index++) {
      const { section, text } = paragraphs[index];
      const embedding = await embedText(`${title} — ${section}: ${text}`);
      await client.query(
        `INSERT INTO wiki_paragraph_embeddings (title, paragraph_index, section, paragraph_text, embedding, version_identifier)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [title, index, section, text, pgvector.toSql(embedding), versionIdentifier ?? null]
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
