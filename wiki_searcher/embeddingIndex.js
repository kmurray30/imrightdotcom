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
import { embedTexts } from './textEmbeddings.js';
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

/**
 * True if this article's stored embeddings are already current — skips
 * re-embedding on a re-run.
 *
 * version_identifier is BIGINT, which node-postgres returns as a JS STRING
 * (not a number — a bigint can exceed Number's safe integer range), while
 * every caller passes versionIdentifier as whatever type it already had
 * (usually a plain JS number, e.g. from Wikimedia's article.version.identifier
 * being JSON-parsed). A strict `===` between those never matches ("100" !==
 * 100), which means this check had never actually skipped anything —
 * confirmed against a live Postgres, where re-embedding an article with an
 * UNCHANGED version still went through the full extract+embed+write path
 * every time instead of returning early. String-normalizing both sides
 * fixes the comparison regardless of which type either side arrives as.
 */
async function isAlreadyCurrent(client, title, versionIdentifier) {
  if (versionIdentifier == null) return false;
  const { rows } = await client.query(
    'SELECT version_identifier FROM wiki_paragraph_embeddings WHERE title = $1 LIMIT 1',
    [title]
  );
  return rows.length > 0 && rows[0].version_identifier != null && String(rows[0].version_identifier) === String(versionIdentifier);
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

let logConnectionWarning = console.error;

/**
 * Redirects this module's connection-drop warnings (below) away from a bare
 * console.error — e.g. so a caller with its own live display (the progress
 * table in build-index-from-wikimedia.js) can redraw around them instead of
 * having them print mid-table and desync its in-place cursor tracking.
 * Defaults to console.error, so nothing changes for callers that never call
 * this (refresh-daily.js, build-index-from-ndjson.js).
 */
export function setConnectionWarningLogger(fn) {
  logConnectionWarning = fn;
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
  // client.query() call still rejects on its own and surfaces through the
  // retry loop's own (louder, more useful) warning below -- so this one
  // stays silent on purpose, purely to stop the raw socket error from being
  // "unhandled"; logging it too would just print the same drop twice.
  const onClientError = () => {};
  client.on('error', onClientError);
  // pool.connect() hands back the SAME underlying client across many calls
  // to this function (it's a pool of 5, reused for every article) -- leaving
  // the listener above attached after release would pile up one more on
  // every reuse of that connection, which is exactly what caused the
  // "MaxListenersExceededWarning: 11 error listeners added to [Client]"
  // seen in practice. Always pair release with removing our own listener
  // first, on every exit path.
  const release = (err) => {
    client.removeListener('error', onClientError);
    client.release(err);
  };
  try {
    if (await isAlreadyCurrent(client, title, versionIdentifier)) {
      release();
      return { title, paragraphCount: 0, skipped: true };
    }

    const paragraphs = extractCitableParagraphs(wikitext ?? '');

    // When pageId is null, `page_id = $2` compares against SQL NULL, which
    // is never true for any row — so the rename-cleanup branch simply never
    // matches, with no need for an explicit "IS NOT NULL" guard.
    if (paragraphs.length === 0) {
      // Nothing to embed for this version, but a prior version's rows (or a
      // renamed page's stale rows under this title/page_id) may still need
      // cleaning up — a lone DELETE, no INSERT half to combine it with.
      await client.query('DELETE FROM wiki_paragraph_embeddings WHERE title = $1 OR (page_id = $2 AND title != $1)', [
        title,
        pageId ?? null,
      ]);
      release();
      return { title, paragraphCount: 0, skipped: false };
    }

    // One batched forward pass for every paragraph in this article instead
    // of one call per paragraph — see textEmbeddings.js's embedTexts.
    const embeddings = await embedTexts(paragraphs.map(({ section, text }) => `${title} — ${section}: ${text}`));

    // DELETE and INSERT combined into ONE round-trip via a data-modifying
    // CTE, instead of two round-trips wrapped in BEGIN/COMMIT. The INSERT's
    // SELECT is CROSS JOINed against the DELETE CTE's row count (always
    // exactly one row, whether or not anything was deleted) purely to create
    // a real data dependency between them — verified against a live
    // Postgres that without this, an *unreferenced* data-modifying CTE runs
    // "concurrently" with the main query (per Postgres's own documented
    // semantics for WITH), so the INSERT's unique(title, paragraph_index)
    // check can run against a snapshot that hasn't seen the DELETE yet and
    // throw a duplicate-key error — which would have fired on every single
    // re-embed of an article whose paragraph count didn't change.
    const insertValues = [title, pageId ?? null];
    const placeholders = paragraphs.map((paragraph, index) => {
      const base = insertValues.length;
      insertValues.push(index, paragraph.section, paragraph.text, pgvector.toSql(embeddings[index]), versionIdentifier ?? null);
      return `($1::text, $2::bigint, $${base + 1}::int, $${base + 2}::text, $${base + 3}::text, $${base + 4}::vector, $${base + 5}::bigint)`;
    });
    await client.query(
      `WITH deleted AS (
         DELETE FROM wiki_paragraph_embeddings WHERE title = $1 OR (page_id = $2 AND title != $1)
         RETURNING 1
       )
       INSERT INTO wiki_paragraph_embeddings (title, page_id, paragraph_index, section, paragraph_text, embedding, version_identifier)
       SELECT v.title, v.page_id, v.paragraph_index, v.section, v.paragraph_text, v.embedding, v.version_identifier
       FROM (VALUES ${placeholders.join(', ')}) AS v(title, page_id, paragraph_index, section, paragraph_text, embedding, version_identifier)
       CROSS JOIN (SELECT count(*) FROM deleted) AS dep(n)`,
      insertValues
    );
    release();
    return { title, paragraphCount: paragraphs.length, skipped: false };
  } catch (error) {
    release(error); // tell pg-pool to discard this client rather than hand a possibly-broken connection to the next caller
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
      logConnectionWarning(`⚠ connection lost (attempt ${attempt}) — ${error.message}, retrying in ${(delayMs / 1000).toFixed(0)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
