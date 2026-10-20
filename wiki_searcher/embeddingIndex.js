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
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { pipeline as streamPipeline } from 'stream/promises';
import yaml from 'yaml';
import copyStreams from 'pg-copy-streams';
import { getPool } from '../imright/scripts/db.js';
import { embedTexts } from './textEmbeddings.js';
import { embedPassages, ARCTIC_DIMS } from './arcticEmbeddings.js';
import { extractSpansParallel } from './spanWorkerPool.js';
import { binaryCopyRows, encodeText, encodeInt4, encodeInt8, encodeJsonb, encodeHalfvec } from './vectorCopy.js';
import { findAllRefs, stripWikiMarkup } from '../ref_extractor/parser/index.js';
import { parseAllCiteTemplates } from '../ref_extractor/parser/citeTemplate.js';

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
 * A vector as pgvector's text literal, with each value written to 9
 * significant digits. pgvector stores float4, and 9 digits round-trip every
 * float4 exactly (FLT_DECIMAL_DIG), so the stored vector is bit-identical to
 * what pgvector.toSql would produce — but pgvector.toSql uses JS's default
 * formatting (up to 17 digits), ~35% more bytes per row. During the bulk
 * build those bytes go over a bandwidth-limited tunnel and were the measured
 * bottleneck (the server spent its time waiting to receive write payloads).
 */
function toVectorLiteral(vector) {
  return '[' + vector.map((x) => String(Number(x.toPrecision(9)))).join(',') + ']';
}

/** True only when both copies carry numeric versions and `a`'s is older; otherwise the later copy wins. */
function isOlderVersion(a, b) {
  const va = String(a.versionIdentifier ?? '');
  const vb = String(b.versionIdentifier ?? '');
  return /^\d+$/.test(va) && /^\d+$/.test(vb) && BigInt(va) < BigInt(vb);
}

/**
 * True when what's stored for a title is the incoming revision or a newer
 * one, so there is nothing to write. The snapshot can carry an older copy of
 * a title in a later chunk; it must not overwrite the newer rows.
 */
function isStoredVersionCurrent(stored, incoming) {
  if (stored == null || incoming == null) return false;
  const s = String(stored);
  const i = String(incoming);
  if (/^\d+$/.test(s) && /^\d+$/.test(i)) return BigInt(s) >= BigInt(i);
  return s === i;
}

/**
 * Newest stored revision for each of the articles' titles and page_ids (a
 * renamed page's rows sit under its old title but share the page_id).
 * One query; both columns are indexed.
 */
async function readStoredVersions(client, articles) {
  const { rows } = await client.query(
    `SELECT title, page_id, max(version_identifier) AS version_identifier FROM ${SPANS_TABLE}
     WHERE title = ANY($1::text[]) OR page_id = ANY($2::bigint[]) GROUP BY title, page_id`,
    [articles.map((a) => a.title), articles.map((a) => a.pageId).filter((id) => id != null)]
  );
  const byTitle = new Map();
  const byPageId = new Map();
  const keepNewest = (map, key, version) => {
    if (key == null || version == null) return;
    const current = map.get(key);
    if (current == null || isStoredVersionCurrent(version, current)) map.set(key, version);
  };
  for (const row of rows) {
    keepNewest(byTitle, row.title, row.version_identifier);
    keepNewest(byPageId, row.page_id == null ? null : String(row.page_id), row.version_identifier);
  }
  return {
    /** True when the table already holds this article's revision or a newer one, under this title or this page_id. */
    isCurrent: ({ title, pageId, versionIdentifier }) =>
      isStoredVersionCurrent(byTitle.get(title), versionIdentifier) ||
      (pageId != null && isStoredVersionCurrent(byPageId.get(String(pageId)), versionIdentifier)),
  };
}

/** Advisory-lock keys for a batch's titles and page_ids: sorted, deduplicated, as int8 strings for a bigint[] parameter. */
function lockKeysFor(targets) {
  const keys = new Set();
  for (const { title, pageId } of targets) {
    keys.add(BigInt.asIntN(64, BigInt('0x' + createHash('sha1').update(title).digest('hex').slice(0, 16))));
    if (pageId != null) keys.add(BigInt(pageId)); // page ids are small positive numbers: no overlap with the hashes in practice, and a collision only over-serializes
  }
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);
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

/**
 * One attempt at upserting a whole BATCH of articles in (at most) two
 * Postgres round trips TOTAL, instead of two round trips PER ARTICLE. Each
 * round trip over the SSH tunnel pays a fixed latency cost regardless of how
 * much the query actually does (Postgres itself answers each of these in
 * low single-digit ms), so the win here is in not paying that fixed cost
 * once per article. Still returns one result per input article, in the
 * same order, so a batch of one (upsertArticleEmbeddings, below) behaves
 * identically to the old per-article version.
 *
 * Adds this attempt's wall-clock time per stage into `timings` (readMs,
 * embedMs, writeMs) — see upsertArticlesBatch.
 */
async function attemptUpsertBatch(pool, articles, timings) {
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
    timings.readMs += performance.now() - dbReadStart;
    const currentVersionByTitle = new Map(rows.map((row) => [row.title, row.version_identifier]));

    // The snapshot can contain the same title more than once. Two copies in
    // one batch would put duplicate (title, paragraph_index) rows into one
    // INSERT, which always fails — reproduced the build's fatal
    // "duplicate key ... title_paragraph_index_key" exactly, and ON CONFLICT
    // can't absorb it either (it refuses to touch the same row twice in one
    // statement). So only the newest copy of each title is written; the
    // other copies are reported as skipped.
    const keptIndexByTitle = new Map();
    articles.forEach((article, i) => {
      const kept = keptIndexByTitle.get(article.title);
      if (kept === undefined || !isOlderVersion(article, articles[kept])) keptIndexByTitle.set(article.title, i);
    });

    const results = new Array(articles.length);
    const targets = []; // { title, pageId } for every article needing a DELETE (and maybe an INSERT)
    const pendingEmbeds = []; // { article, paragraphs } for every article that also needs an INSERT

    articles.forEach((article, i) => {
      const { title, wikitext, versionIdentifier, pageId } = article;
      if (keptIndexByTitle.get(title) !== i) {
        results[i] = { title, paragraphCount: 0, skipped: true }; // superseded by another copy of this title in the batch
        return;
      }
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
      timings.embedMs += performance.now() - embedStart;

      let offset = 0;
      for (const { article, paragraphs } of pendingEmbeds) {
        paragraphs.forEach((paragraph, index) => {
          insertRows.push({
            title: article.title,
            pageId: article.pageId ?? null,
            index,
            section: paragraph.section,
            text: paragraph.text,
            embedding: toVectorLiteral(embeddings[offset + index]),
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
        //
        // ON CONFLICT covers a different collision: the same title being
        // written by two chunks at once (duplicate copies of a title can land
        // in different chunks). Neither transaction's DELETE can see the
        // other's uncommitted rows, so the second INSERT hit a duplicate-key
        // error once the first committed — reproduced against the live
        // database; with ON CONFLICT the second write simply overwrites.
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
           CROSS JOIN (SELECT count(*) FROM deleted) AS dep(n)
           ON CONFLICT (title, paragraph_index) DO UPDATE SET
             page_id = EXCLUDED.page_id, section = EXCLUDED.section, paragraph_text = EXCLUDED.paragraph_text,
             embedding = EXCLUDED.embedding, version_identifier = EXCLUDED.version_identifier, updated_at = now()`,
          [...targetParams, ...insertParams]
        );
      }
      timings.writeMs += performance.now() - dbWriteStart;
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
 * `timings` (optional) receives this batch's wall-clock time per stage:
 * readMs (already-current check), embedMs, writeMs (DELETE+INSERT) —
 * accumulated across retries, so it's the real time this batch cost. Passed
 * in per call rather than reported through a global hook, so a caller running
 * several batches concurrently can attribute each batch's numbers exactly.
 *
 * @param {Array<{title: string, wikitext: string, versionIdentifier: *, pageId: *}>} articles
 * @param {{readMs: number, embedMs: number, writeMs: number}} [timings]
 * @returns {Promise<Array<{title: string, paragraphCount: number, skipped: boolean}>>} one result per input article, same order
 */
export async function upsertArticlesBatch(articles, timings = { readMs: 0, embedMs: 0, writeMs: 0 }) {
  if (articles.length === 0) return [];
  const pool = getPool();
  if (!pool) {
    throw new Error('DATABASE_URL is not set; cannot write to the wiki paragraph vector index.');
  }

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await attemptUpsertBatch(pool, articles, timings);
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

// =====================================================================
// Cited spans (wiki_citation_spans): the rebuilt index. One row per
// citation group inside a paragraph — the text that group supports, plus its
// citations — extracted from Wikimedia's rendered HTML by spanExtractor.js
// and embedded with arctic-embed-m-v1.5 (arcticEmbeddings.js). Nothing
// uncited is stored. The paragraph functions above stay until serving and
// the daily refresh move over.
// =====================================================================

export const SPANS_TABLE = 'wiki_citation_spans';
/**
 * Which content units become spans. Measured on a 500-article Enterprise
 * sample (scripts/sample-article-structure.js): paragraphs hold 83% of cited
 * text, table rows 14%, list items 3%; rows and items add ~21% more spans
 * (7.7M of 37M projected). Both are in: dropping a kind later is one DELETE
 * by `kind`, adding one later means re-reading the whole snapshot.
 */
export const SPAN_OPTIONS = { includeListItems: true, includeTableRows: true };

const SPANS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${SPANS_TABLE} (
    id                 BIGSERIAL PRIMARY KEY,
    title              TEXT NOT NULL,
    page_id            BIGINT,
    version_identifier BIGINT,
    section            TEXT NOT NULL,
    kind               TEXT NOT NULL,
    unit_index         INT NOT NULL,
    span_index         INT NOT NULL,
    span_text          TEXT NOT NULL,
    citations          JSONB NOT NULL,
    embedding          halfvec(${ARCTIC_DIMS}) NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (title, kind, unit_index, span_index)
  )`;

/** Same columns as the COPY below, minus id/updated_at (the table's defaults fill those on INSERT). */
const SPAN_COLUMNS = ['title', 'page_id', 'version_identifier', 'section', 'kind', 'unit_index', 'span_index', 'span_text', 'citations', 'embedding'];

/**
 * Cited spans that are stored but not embedded: their citations are all
 * offline (a book with no url, a short footnote, a plain-text reference, an
 * excluded host) or the span is under the size floor. Same locator and
 * content columns as the embedded table, so a span can be found by the same
 * key, plus why it is here. Kept so a later change of rules never needs the
 * snapshot again.
 */
export const UNEMBEDDED_TABLE = 'wiki_citation_spans_unembedded';
const UNEMBEDDED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${UNEMBEDDED_TABLE} (
    id                 BIGSERIAL PRIMARY KEY,
    title              TEXT NOT NULL,
    page_id            BIGINT,
    version_identifier BIGINT,
    section            TEXT NOT NULL,
    kind               TEXT NOT NULL,
    unit_index         INT NOT NULL,
    span_index         INT NOT NULL,
    span_text          TEXT NOT NULL,
    citations          JSONB NOT NULL,
    reason             TEXT NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (title, kind, unit_index, span_index)
  )`;
const UNEMBEDDED_COLUMNS = ['title', 'page_id', 'version_identifier', 'section', 'kind', 'unit_index', 'span_index', 'span_text', 'citations', 'reason'];

/**
 * Creates the spans table if needed and round-trips one known vector through
 * the exact binary COPY path the build uses, so an encoding mismatch fails
 * here — before any real rows — instead of silently storing garbage vectors.
 */
export async function ensureSpansTable() {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set; cannot create the wiki citation span index.');
  await pool.query(SPANS_TABLE_SQL);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${SPANS_TABLE}_page_id ON ${SPANS_TABLE} (page_id)`);
  await pool.query(UNEMBEDDED_TABLE_SQL);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${UNEMBEDDED_TABLE}_page_id ON ${UNEMBEDDED_TABLE} (page_id)`);

  const probe = Array.from({ length: ARCTIC_DIMS }, (_, i) => Math.sin(i + 1) / 10);
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE encoding_check (id bigint, embedding halfvec(${ARCTIC_DIMS}))`);
    await streamPipeline(
      Readable.from([binaryCopyRows([[encodeInt8(1), encodeHalfvec(probe)]])]),
      client.query(copyStreams.from('COPY encoding_check (id, embedding) FROM STDIN (FORMAT binary)'))
    );
    const { rows: [{ text }] } = await client.query('SELECT embedding::text AS text FROM encoding_check');
    const stored = JSON.parse(text);
    const worst = Math.max(...stored.map((v, i) => Math.abs(v - probe[i])));
    if (stored.length !== ARCTIC_DIMS || !(worst < 1e-3)) {
      throw new Error(`halfvec binary encoding check failed (dims ${stored.length}, worst error ${worst}) — nothing was written`);
    }
    await client.query('DROP TABLE encoding_check');
  } finally {
    client.release();
  }
}

function toInt8OrNull(value) {
  return value == null || value === '' ? null : encodeInt8(value);
}

/**
 * One attempt at upserting a batch of articles' cited spans: one read round
 * trip (which titles are already current), one embedding call for every
 * span in the batch, then one transaction: DELETE the articles' old rows
 * (incl. a renamed page's rows under its old title, via page_id), binary
 * COPY the new rows into a temp table, INSERT … ON CONFLICT from it. Same
 * contract and reasoning as attemptUpsertBatch above; the COPY replaces the
 * giant VALUES list because a span row carries ~1 KB (text + citations JSON
 * + a 516-byte vector) and this goes over a bandwidth-limited tunnel.
 */
async function attemptUpsertSpans(pool, articles, timings) {
  const client = await pool.connect();
  const onClientError = () => {};
  client.on('error', onClientError);
  const release = (err) => {
    client.removeListener('error', onClientError);
    client.release(err);
  };
  let inTransaction = false;
  try {
    const dbReadStart = performance.now();
    const stored = await readStoredVersions(client, articles);
    timings.readMs += performance.now() - dbReadStart;

    const keptIndexByTitle = new Map();
    articles.forEach((article, i) => {
      const kept = keptIndexByTitle.get(article.title);
      if (kept === undefined || !isOlderVersion(article, articles[kept])) keptIndexByTitle.set(article.title, i);
    });

    const results = new Array(articles.length);
    const targets = [];
    const pending = [];
    const toExtract = [];
    articles.forEach((article, i) => {
      const { title } = article;
      if (keptIndexByTitle.get(title) !== i || stored.isCurrent(article)) {
        results[i] = { title, spanCount: 0, unembeddedCount: 0, skipped: true };
        return;
      }
      toExtract.push(i);
    });
    // HTML parsing runs on worker threads (spanWorkerPool.js) so it overlaps
    // with other batches' embedding and writes instead of blocking them.
    const extractStart = performance.now();
    const extracted = await extractSpansParallel(toExtract.map((i) => articles[i]), SPAN_OPTIONS);
    timings.extractMs = (timings.extractMs ?? 0) + (performance.now() - extractStart);
    toExtract.forEach((i, j) => {
      const { title, pageId } = articles[i];
      const { spans, unembedded } = extracted[j];
      targets.push({ index: i, title, pageId: pageId ?? null });
      results[i] = { title, spanCount: spans.length, unembeddedCount: unembedded.length, skipped: false };
      if (spans.length > 0 || unembedded.length > 0) pending.push({ index: i, article: articles[i], spans, unembedded, vectors: [] });
    });

    const texts = pending.flatMap(({ article, spans }) => spans.map((s) => `${article.title} — ${s.section}: ${s.text}`));
    if (texts.length > 0) {
      const embedStart = performance.now();
      const vectors = await embedPassages(texts);
      timings.embedMs += performance.now() - embedStart;
      let offset = 0;
      for (const entry of pending) {
        entry.vectors = vectors.slice(offset, offset + entry.spans.length);
        offset += entry.spans.length;
      }
    }

    let dbWriteStart = 0;
    if (targets.length > 0) {
      dbWriteStart = performance.now();
      await client.query('BEGIN');
      inTransaction = true;

      // Parallel chunks can carry copies of the same page, so two batches can
      // reach this point with the same title (or page_id). Per-title/page
      // advisory locks, held to the end of the transaction and taken in sorted
      // order (no deadlocks between batches), serialize them; the re-read
      // under the lock then drops anything the other writer already stored,
      // so an older copy never undoes a newer one. The locks are one round
      // trip for the whole batch.
      await client.query('SELECT pg_advisory_xact_lock(k) FROM unnest($1::bigint[]) AS k', [lockKeysFor(targets)]);
      const locked = await readStoredVersions(client, targets.map((t) => articles[t.index]));
      for (let j = targets.length - 1; j >= 0; j--) {
        const target = targets[j];
        if (!locked.isCurrent(articles[target.index])) continue;
        results[target.index] = { title: target.title, spanCount: 0, unembeddedCount: 0, skipped: true };
        targets.splice(j, 1);
        const p = pending.findIndex((entry) => entry.index === target.index);
        if (p !== -1) pending.splice(p, 1);
      }
    }

    if (targets.length > 0) {

      const targetParams = [];
      const targetPlaceholders = targets.map(({ title, pageId }) => {
        const base = targetParams.length;
        targetParams.push(title, pageId);
        return `($${base + 1}::text, $${base + 2}::bigint)`;
      });
      for (const table of [SPANS_TABLE, UNEMBEDDED_TABLE]) {
        await client.query(
          `DELETE FROM ${table} e USING (VALUES ${targetPlaceholders.join(', ')}) AS t(title, page_id)
           WHERE e.title = t.title OR (e.page_id = t.page_id AND e.title != t.title)`,
          targetParams
        );
      }

      const rowsToCopy = [];
      const unembeddedRows = [];
      for (const { article, spans, unembedded, vectors } of pending) {
        const locator = (span) => [
          encodeText(article.title),
          toInt8OrNull(article.pageId),
          toInt8OrNull(article.versionIdentifier),
          encodeText(span.section),
          encodeText(span.kind),
          encodeInt4(span.unitIndex),
          encodeInt4(span.spanIndex),
          encodeText(span.text),
          encodeJsonb(span.citations),
        ];
        spans.forEach((span, index) => rowsToCopy.push([...locator(span), encodeHalfvec(vectors[index])]));
        for (const span of unembedded) unembeddedRows.push([...locator(span), encodeText(span.reason)]);
      }
      if (rowsToCopy.length > 0) {
        await client.query(
          `CREATE TEMP TABLE spans_in (title text, page_id bigint, version_identifier bigint, section text, kind text,
             unit_index int, span_index int, span_text text, citations jsonb, embedding halfvec(${ARCTIC_DIMS})) ON COMMIT DROP`
        );
        await streamPipeline(
          Readable.from([binaryCopyRows(rowsToCopy)]),
          client.query(copyStreams.from(`COPY spans_in (${SPAN_COLUMNS.join(', ')}) FROM STDIN (FORMAT binary)`))
        );
        // ON CONFLICT: the same title written by two chunks at once (duplicate
        // copies of a title can land in different chunks) — the second write
        // overwrites instead of failing on the unique key.
        await client.query(
          `INSERT INTO ${SPANS_TABLE} (${SPAN_COLUMNS.join(', ')})
           SELECT ${SPAN_COLUMNS.join(', ')} FROM spans_in
           ON CONFLICT (title, kind, unit_index, span_index) DO UPDATE SET
             page_id = EXCLUDED.page_id, version_identifier = EXCLUDED.version_identifier, section = EXCLUDED.section,
             span_text = EXCLUDED.span_text, citations = EXCLUDED.citations, embedding = EXCLUDED.embedding, updated_at = now()`
        );
      }
      if (unembeddedRows.length > 0) {
        await client.query(
          `CREATE TEMP TABLE unembedded_in (title text, page_id bigint, version_identifier bigint, section text, kind text,
             unit_index int, span_index int, span_text text, citations jsonb, reason text) ON COMMIT DROP`
        );
        await streamPipeline(
          Readable.from([binaryCopyRows(unembeddedRows)]),
          client.query(copyStreams.from(`COPY unembedded_in (${UNEMBEDDED_COLUMNS.join(', ')}) FROM STDIN (FORMAT binary)`))
        );
        await client.query(
          `INSERT INTO ${UNEMBEDDED_TABLE} (${UNEMBEDDED_COLUMNS.join(', ')})
           SELECT ${UNEMBEDDED_COLUMNS.join(', ')} FROM unembedded_in
           ON CONFLICT (title, kind, unit_index, span_index) DO UPDATE SET
             page_id = EXCLUDED.page_id, version_identifier = EXCLUDED.version_identifier, section = EXCLUDED.section,
             span_text = EXCLUDED.span_text, citations = EXCLUDED.citations, reason = EXCLUDED.reason, updated_at = now()`
        );
      }
    }
    if (inTransaction) {
      await client.query('COMMIT');
      inTransaction = false;
      timings.writeMs += performance.now() - dbWriteStart;
    }

    release();
    return results;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    release(error);
    throw error;
  }
}

/**
 * Embeds and upserts many articles' cited spans. Replaces all of each
 * article's existing rows (so a shrinking article leaves nothing stale),
 * skips articles whose version_identifier is already stored, and retries
 * connection failures forever with capped backoff — the same contract as
 * upsertArticlesBatch, which see. The whole write is one transaction, so a
 * retried attempt never finds half a batch already committed.
 *
 * @param {Array<{title: string, html: string, versionIdentifier: *, pageId: *}>} articles - `html` is article_body.html
 * @param {{readMs: number, embedMs: number, writeMs: number}} [timings]
 * @returns {Promise<Array<{title: string, spanCount: number, unembeddedCount: number, skipped: boolean}>>} one result per input article, same order; spanCount = embedded spans, unembeddedCount = spans stored in UNEMBEDDED_TABLE
 */
export async function upsertSpansBatch(articles, timings = { readMs: 0, embedMs: 0, writeMs: 0 }) {
  if (articles.length === 0) return [];
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set; cannot write to the wiki citation span index.');

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await attemptUpsertSpans(pool, articles, timings);
    } catch (error) {
      if (!isRetryableConnectionError(error) && error.code !== '40P01' /* deadlock_detected: retry the attempt */) throw error;
      const delayMs = Math.min(DB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), DB_RETRY_MAX_DELAY_MS);
      logConnectionWarning(`⚠ connection lost (attempt ${attempt}) — ${error.message}, retrying in ${(delayMs / 1000).toFixed(0)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Single-article wrapper around upsertSpansBatch (a batch of one). */
export async function upsertArticleSpans(article) {
  const [result] = await upsertSpansBatch([article]);
  return result;
}
