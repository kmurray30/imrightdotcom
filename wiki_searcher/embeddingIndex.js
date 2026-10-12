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

let reportStageTiming = () => {};

/**
 * Redirects per-stage wall-clock timings (DB round trips vs. the embedding
 * call itself) to a caller-supplied reporter — e.g. the live progress table
 * in build-index-from-wikimedia.js, which uses this to show where a slowdown
 * actually is (network download, CPU-bound embedding, or the Postgres/tunnel
 * round trip) instead of requiring a side investigation every time Art/s
 * drops. Defaults to a no-op, so nothing changes for callers that never call
 * this (refresh-daily.js, build-index-from-ndjson.js).
 * @param {(stage: 'db' | 'embed', ms: number) => void} fn
 */
export function setStageTimingReporter(fn) {
  reportStageTiming = fn;
}

/**
 * One attempt at upserting a whole BATCH of articles in (at most) two
 * Postgres round trips TOTAL, instead of two round trips PER ARTICLE. Each
 * round trip over the SSH tunnel pays a fixed latency cost regardless of how
 * much the query actually does (Postgres itself answers each of these in
 * low single-digit ms), so the win here is in not paying that fixed cost
 * once per article. Still returns one result per input article, in the
 * same order, so a batch of one (upsertArticleEmbeddings, below) behaves
 * identically to the old per-article version.
 */
async function attemptUpsertBatch(pool, articles) {
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
  // to this function -- leaving the listener above attached after release
  // would pile up one more on every reuse of that connection, which is
  // exactly what caused the "MaxListenersExceededWarning: 11 error
  // listeners added to [Client]" seen in practice. Always pair release with
  // removing our own listener first, on every exit path.
  const release = (err) => {
    client.removeListener('error', onClientError);
    client.release(err);
  };
  try {
    // ONE round trip to find out which titles are already current, instead
    // of one per article. version_identifier is BIGINT, which node-postgres
    // returns as a JS STRING (not a number — a bigint can exceed Number's
    // safe integer range), while a caller's versionIdentifier may arrive as
    // a plain JS number (e.g. Wikimedia's article.version.identifier,
    // JSON-parsed) — string-normalizing both sides before comparing is what
    // makes this check actually skip anything (a strict `===` between "100"
    // and 100 never matches, confirmed against a live Postgres where that
    // bug meant re-embedding an unchanged article never skipped at all).
    const dbReadStart = performance.now();
    const { rows } = await client.query(
      'SELECT title, version_identifier FROM wiki_paragraph_embeddings WHERE title = ANY($1::text[])',
      [articles.map((a) => a.title)]
    );
    reportStageTiming('db', (performance.now() - dbReadStart) / articles.length);
    const currentVersionByTitle = new Map(rows.map((row) => [row.title, row.version_identifier]));

    const results = new Array(articles.length);
    const targets = []; // { title, pageId } for every article needing a DELETE (and maybe an INSERT)
    const pendingEmbeds = []; // { article, paragraphs } for every article that also needs an INSERT

    articles.forEach((article, i) => {
      const { title, wikitext, versionIdentifier, pageId } = article;
      const currentVersion = currentVersionByTitle.get(title);
      const alreadyCurrent =
        versionIdentifier != null && currentVersion != null && String(currentVersion) === String(versionIdentifier);
      if (alreadyCurrent) {
        results[i] = { title, paragraphCount: 0, skipped: true };
        return;
      }

      const paragraphs = extractCitableParagraphs(wikitext ?? '');
      // When pageId is null, `page_id = t.page_id` compares against SQL
      // NULL, which is never true for any row — so the rename-cleanup half
      // simply never matches, with no need for an explicit "IS NOT NULL" guard.
      targets.push({ title, pageId: pageId ?? null });
      if (paragraphs.length === 0) {
        // Nothing to embed for this version, but a prior version's rows (or
        // a renamed page's stale rows under this title/page_id) may still
        // need cleaning up — this article only contributes to the DELETE side.
        results[i] = { title, paragraphCount: 0, skipped: false };
        return;
      }
      results[i] = { title, paragraphCount: paragraphs.length, skipped: false };
      pendingEmbeds.push({ article, paragraphs });
    });

    // Every pending article's paragraphs go into ONE embedTexts call, not one
    // call per article — the model's fixed per-call overhead dwarfs the
    // actual compute for a handful of paragraphs, especially on a GPU (see
    // textEmbeddings.js's embedTexts, which also sub-batches by length).
    // Vectors come back in input order, so each article's slice starts where
    // its paragraphs were appended.
    const insertRows = [];
    if (pendingEmbeds.length > 0) {
      const allTexts = pendingEmbeds.flatMap(({ article, paragraphs }) =>
        paragraphs.map(({ section, text }) => `${article.title} — ${section}: ${text}`)
      );
      const embedStart = performance.now();
      const embeddings = await embedTexts(allTexts);
      reportStageTiming('embed', (performance.now() - embedStart) / pendingEmbeds.length);

      let offset = 0;
      for (const { article, paragraphs } of pendingEmbeds) {
        paragraphs.forEach((paragraph, index) => {
          insertRows.push({
            title: article.title,
            pageId: article.pageId ?? null,
            index,
            section: paragraph.section,
            text: paragraph.text,
            embedding: pgvector.toSql(embeddings[offset + index]),
            versionIdentifier: article.versionIdentifier ?? null,
          });
        });
        offset += paragraphs.length;
      }
    }

    if (targets.length > 0) {
      const dbWriteStart = performance.now();
      const targetParams = [];
      const targetPlaceholders = targets.map(({ title, pageId }) => {
        const base = targetParams.length;
        targetParams.push(title, pageId);
        return `($${base + 1}::text, $${base + 2}::bigint)`;
      });

      if (insertRows.length === 0) {
        // Only stale rows to clean up across this batch (rename/deletion
        // cases) — no INSERT half to combine it with.
        await client.query(
          `DELETE FROM wiki_paragraph_embeddings e
           USING (VALUES ${targetPlaceholders.join(', ')}) AS t(title, page_id)
           WHERE e.title = t.title OR (e.page_id = t.page_id AND e.title != t.title)`,
          targetParams
        );
      } else {
        // DELETE and INSERT combined into ONE round-trip via a data-modifying
        // CTE, instead of two round-trips wrapped in BEGIN/COMMIT. The
        // INSERT's SELECT is CROSS JOINed against the DELETE CTE's row count
        // (always exactly one row, whether or not anything was deleted)
        // purely to create a real data dependency between them — verified
        // against a live Postgres that without this, an *unreferenced*
        // data-modifying CTE runs "concurrently" with the main query (per
        // Postgres's own documented semantics for WITH), so the INSERT's
        // unique(title, paragraph_index) check can run against a snapshot
        // that hasn't seen the DELETE yet and throw a duplicate-key error —
        // which would have fired on every single re-embed of an article
        // whose paragraph count didn't change.
        const insertParams = [];
        const insertPlaceholders = insertRows.map((row) => {
          const base = targetParams.length + insertParams.length;
          insertParams.push(row.title, row.pageId, row.index, row.section, row.text, row.embedding, row.versionIdentifier);
          return `($${base + 1}::text, $${base + 2}::bigint, $${base + 3}::int, $${base + 4}::text, $${base + 5}::text, $${base + 6}::vector, $${base + 7}::bigint)`;
        });
        await client.query(
          `WITH targets(title, page_id) AS (
             VALUES ${targetPlaceholders.join(', ')}
           ),
           deleted AS (
             DELETE FROM wiki_paragraph_embeddings e
             USING targets t
             WHERE e.title = t.title OR (e.page_id = t.page_id AND e.title != t.title)
             RETURNING 1
           )
           INSERT INTO wiki_paragraph_embeddings (title, page_id, paragraph_index, section, paragraph_text, embedding, version_identifier)
           SELECT v.title, v.page_id, v.paragraph_index, v.section, v.paragraph_text, v.embedding, v.version_identifier
           FROM (VALUES ${insertPlaceholders.join(', ')}) AS v(title, page_id, paragraph_index, section, paragraph_text, embedding, version_identifier)
           CROSS JOIN (SELECT count(*) FROM deleted) AS dep(n)`,
          [...targetParams, ...insertParams]
        );
      }
      reportStageTiming('db', (performance.now() - dbWriteStart) / articles.length);
    }

    release();
    return results;
  } catch (error) {
    release(error); // tell pg-pool to discard this client rather than hand a possibly-broken connection to the next caller
    throw error;
  }
}

/**
 * Embeds and upserts many articles' citation-adjacent paragraphs in (at
 * most) two Postgres round trips for the WHOLE BATCH, instead of two per
 * article — see attemptUpsertBatch for why that matters. Replaces all of
 * each article's existing rows, so a shrinking article (fewer citable
 * paragraphs than before) doesn't leave stale ones behind. Resumable: a
 * second call with the same versionIdentifier is a no-op for that article.
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
 * Safe to retry the whole batch from scratch: every DB statement here is a
 * single atomic statement (no partial writes to undo), so a retried attempt
 * just re-does the same read-then-write cleanly rather than risking
 * double-written rows.
 *
 * @param {Array<{title: string, wikitext: string, versionIdentifier: *, pageId: *}>} articles
 * @returns {Promise<Array<{title: string, paragraphCount: number, skipped: boolean}>>} one result per input article, same order
 */
export async function upsertArticlesBatch(articles) {
  if (articles.length === 0) return [];
  const pool = getPool();
  if (!pool) {
    throw new Error('DATABASE_URL is not set; cannot write to the wiki paragraph vector index.');
  }

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await attemptUpsertBatch(pool, articles);
    } catch (error) {
      if (!isRetryableConnectionError(error)) throw error;
      const delayMs = Math.min(DB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), DB_RETRY_MAX_DELAY_MS);
      logConnectionWarning(`⚠ connection lost (attempt ${attempt}) — ${error.message}, retrying in ${(delayMs / 1000).toFixed(0)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Single-article convenience wrapper around upsertArticlesBatch (a batch of
 * one) — for callers that process one article at a time (refresh-daily.js,
 * build-index-from-ndjson.js). See upsertArticlesBatch for the full
 * behavior/retry contract; nothing here changes for them. A caller that
 * already has several articles ready together (build-index-from-wikimedia.js)
 * should call upsertArticlesBatch directly instead, to get the round-trip
 * savings.
 *
 * @param {object} article - { title, wikitext, versionIdentifier, pageId }
 * @returns {Promise<{ title: string, paragraphCount: number, skipped: boolean }>}
 */
export async function upsertArticleEmbeddings(article) {
  const [result] = await upsertArticlesBatch([article]);
  return result;
}
