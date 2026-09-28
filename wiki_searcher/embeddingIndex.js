/**
 * Shared logic for populating wiki_paragraph_embeddings — used by the
 * one-time full build (scripts/build-index-from-wikimedia.js, or
 * scripts/build-index-from-ndjson.js for an NDJSON file you already have)
 * and the daily refresh (scripts/refresh-daily.js), so there's exactly one
 * place that decides how an article's wikitext becomes indexed paragraphs.
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
import { embedText } from './textEmbeddings.js';
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

const DB_RETRY_BASE_DELAY_MS = 2000;
const DB_RETRY_MAX_DELAY_MS = 60_000; // cap backoff so "retry forever" doesn't mean waiting an hour between attempts

// Error signatures that mean "the connection itself is the problem" (a flaky
// tunnel dropping/reconnecting) as opposed to a real bug in the query or
// data — only these are worth retrying forever. Node's network error codes
// plus Postgres's connection-related SQLSTATEs (57P0x admin/crash shutdown,
// 08xxx connection_exception family) and our own statement_timeout firing
// (57014) all indicate the session is dead, not that the write was wrong.
// "Connection terminated unexpectedly" has no .code at all (it's a plain
// Error thrown by pg's own client.js), hence the message-based fallback.
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  '57P01', '57P02', '57P03',
  '08000', '08001', '08003', '08004', '08006',
  '57014',
]);
const RETRYABLE_ERROR_MESSAGES = ['Connection terminated unexpectedly', 'Connection terminated due to connection timeout'];

function isRetryableConnectionError(error) {
  if (error?.code && RETRYABLE_ERROR_CODES.has(error.code)) return true;
  return typeof error?.message === 'string' && RETRYABLE_ERROR_MESSAGES.some((msg) => error.message.includes(msg));
}

/** One attempt at the full upsert — pulled out of upsertArticleEmbeddings so that function can wrap it in a retry loop. */
async function attemptUpsert(pool, { title, wikitext, versionIdentifier, pageId }) {
  const client = await pool.connect();
  // pg-pool removes its own idle-client error listener the instant a client
  // is handed off via pool.connect() (see _acquireClient in pg-pool's
  // source) -- from here until client.release(), an unexpected connection
  // drop (e.g. a flaky SSH tunnel) has no listener at all unless we add one,
  // which Node then treats as an unhandled 'error' event and crashes the
  // whole process, bypassing the try/catch below entirely. The in-flight
  // client.query() call still rejects on its own and is handled normally;
  // this only stops the redundant raw socket error from being "unhandled".
  client.on('error', (err) => {
    console.error(`[embed] DB connection error while embedding "${title}":`, err.message);
  });
  try {
    if (await isAlreadyCurrent(client, title, versionIdentifier)) {
      client.release();
      return { title, paragraphCount: 0, skipped: true };
    }

    const paragraphs = extractCitableParagraphs(wikitext ?? '');

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
    client.release();
    return { title, paragraphCount: paragraphs.length, skipped: false };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is very likely already dead (often WHY we're here) --
      // nothing to roll back to. The original `error` below is what matters,
      // not whatever this rollback attempt raised.
    }
    client.release(error); // tell pg-pool to discard this client rather than hand a possibly-broken connection to the next caller
    throw error;
  }
}

/**
 * Embeds and upserts an article's citation-adjacent paragraphs. Replaces all
 * of that article's existing rows, so a shrinking article (fewer citable
 * paragraphs than before) doesn't leave stale ones behind. Resumable: a
 * second call with the same versionIdentifier is a no-op.
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
 * Retries forever (capped backoff, never a max attempt count) on a
 * connection-shaped failure specifically — e.g. a flaky local SSH tunnel
 * dropping mid-run — logging loudly on every attempt so a long unattended
 * run is distinguishable from "stuck" rather than silently hanging or dying.
 * A non-connection error (a real bug, bad data) still fails immediately;
 * retrying that forever would just be a different flavor of silent hang.
 * Safe to retry the whole thing from scratch: nothing commits until the
 * final COMMIT, so a retried attempt re-does the DELETE+re-INSERT cleanly
 * rather than risking double-written rows.
 *
 * @param {object} article - { title, wikitext, versionIdentifier, pageId }
 * @returns {Promise<{ title: string, paragraphCount: number, skipped: boolean }>}
 */
export async function upsertArticleEmbeddings({ title, wikitext, versionIdentifier, pageId }) {
  const pool = getPool();
  if (!pool) {
    throw new Error('DATABASE_URL is not set; cannot write to the wiki paragraph vector index.');
  }

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await attemptUpsert(pool, { title, wikitext, versionIdentifier, pageId });
    } catch (error) {
      if (!isRetryableConnectionError(error)) throw error;
      const delayMs = Math.min(DB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), DB_RETRY_MAX_DELAY_MS);
      console.error(
        `[embed] DB connection problem while embedding "${title}" (attempt ${attempt}): ${error.message} ` +
          `— retrying in ${(delayMs / 1000).toFixed(0)}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
