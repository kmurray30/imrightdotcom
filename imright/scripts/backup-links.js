/**
 * Persists live-url -> archive-url pairs for citations that have both, in Postgres (see db.js).
 * This is deliberately *not* a general link-metadata table: it only ever holds citations where
 * ref_extractor found a working live link AND Wikipedia's archive_url for it, because that's the
 * only case where there's ever something useful to do later (swap to the archive copy if the live
 * one dies). A citation with no archive fallback has nothing to heal to, so it's never written
 * here—querying it at render time would just fall back to the url as originally stored anyway.
 *
 * Nothing reads this table yet (that lands with the future render step + link-checking sweep), so
 * writes here are pure upside: if this table is ever dropped, disabled, or never queried, articles
 * render exactly as they do today with no code changes required.
 */

import { getPool } from './db.js';

let ensureTablePromise = null;

function ensureTable(pool) {
  if (!ensureTablePromise) {
    ensureTablePromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS backup_links (
           url TEXT PRIMARY KEY,
           archive_url TEXT NOT NULL,
           is_dead BOOLEAN NOT NULL DEFAULT false,
           checked_at TIMESTAMPTZ
         )`
      )
      .then(() => true)
      .catch((error) => {
        ensureTablePromise = null;
        throw error;
      });
  }
  return ensureTablePromise;
}

/**
 * Flatten the ref_extractor `extracted` structure ({ [searchTerm]: [citation, ...] }) into the
 * deduplicated (url, archive_url) pairs worth persisting: only citations where both a live link
 * and an archive fallback survived extraction.
 *
 * @param {Record<string, Array<{ link?: string, archiveLink?: string | null }>>} extracted
 * @returns {Array<{ url: string, archiveUrl: string }>}
 */
export function citationsToBackupLinkRows(extracted) {
  const seen = new Set();
  const rows = [];

  for (const citations of Object.values(extracted ?? {})) {
    if (!Array.isArray(citations)) continue;
    for (const citation of citations) {
      const url = citation?.link;
      const archiveUrl = citation?.archiveLink;
      if (!url || !archiveUrl) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      rows.push({ url, archiveUrl });
    }
  }

  return rows;
}

/**
 * Upserts (url, archive_url) pairs from a completed ref_extractor run. Best-effort: a missing
 * DATABASE_URL or a DB error is logged and swallowed rather than thrown, since this is ancillary
 * bookkeeping for a not-yet-built feature—it must never fail article generation.
 *
 * @param {Record<string, Array<object>>} extracted - Output of ref_extractor's extract()
 */
export async function upsertBackupLinks(extracted) {
  const rows = citationsToBackupLinkRows(extracted);
  if (rows.length === 0) return;

  const pool = getPool();
  if (!pool) return; // getPool() already warns once when DATABASE_URL is unset

  try {
    await ensureTable(pool);
    await pool.query(
      `INSERT INTO backup_links (url, archive_url)
       SELECT * FROM UNNEST($1::text[], $2::text[])
       ON CONFLICT (url) DO NOTHING`,
      [rows.map((row) => row.url), rows.map((row) => row.archiveUrl)]
    );
  } catch (error) {
    console.error('[backup-links] upsert failed, continuing without it:', error?.message ?? error);
  }
}
