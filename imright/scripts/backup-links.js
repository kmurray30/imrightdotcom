/**
 * Persists live-url -> archive-url pairs for citations that have both, in Postgres (see db.js).
 * This is deliberately *not* a general link-metadata table: it only ever holds citations where
 * ref_extractor found a working live link AND Wikipedia's archive_url for it, because that's the
 * only case where there's ever something useful to do later (swap to the archive copy if the live
 * one dies). A citation with no archive fallback has nothing to heal to, so it's never written
 * here—querying it at render time would just fall back to the url as originally stored anyway.
 *
 * There's no separate crawler/sweep job. Staleness checks are lazy, triggered by real pageviews:
 * resolveLinks() is called from the client-side link-status endpoint with the urls on the page
 * being viewed, and for any url not re-checked in STALE_AFTER_MS, kicks off a background recheck
 * (never blocking the response—the visitor already has a fully usable page with the original
 * link). If this table is ever dropped, disabled, or never queried, articles render exactly as
 * they do today with no code changes required.
 */

import { getPool } from './db.js';
import { checkUrl, LinkStatus } from '../../utils/linkChecker.js';

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
 * checked_at is seeded to the moment of insert, not left null: ref_extractor only ever includes
 * a citation here after its live link already passed a check during extraction, so "just
 * inserted" and "just checked" are the same fact. That starts the staleness clock from a real
 * check instead of treating a brand new link as if it had never been verified.
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
      `INSERT INTO backup_links (url, archive_url, checked_at)
       SELECT u, a, now() FROM UNNEST($1::text[], $2::text[]) AS t(u, a)
       ON CONFLICT (url) DO NOTHING`,
      [rows.map((row) => row.url), rows.map((row) => row.archiveUrl)]
    );
  } catch (error) {
    console.error('[backup-links] upsert failed, continuing without it:', error?.message ?? error);
  }
}

/**
 * Batched read for a page's citation urls, resolving each to its current best link.
 * Best-effort: on any failure, or if a url has no row, that url is simply absent from the
 * returned map—callers should leave those hrefs untouched, exactly as if this table didn't exist.
 *
 * Also (fire-and-forget, never awaited by the caller) kicks off a background recheck for any
 * still-alive url whose last check is older than STALE_AFTER_MS. The visitor viewing this page
 * gets the fully usable page immediately with the currently-known-good link; if the recheck finds
 * it's now dead, the *next* visitor (or a client-side re-poll) sees the healed link. No separate
 * scheduled job—this function is the only thing that ever rechecks a link, and it only runs
 * because a real pageview asked about that url.
 *
 * @param {string[]} urls
 * @returns {Promise<Map<string, string>>} - url -> resolved link, only for urls with a row
 */
export async function resolveLinks(urls) {
  const resolved = new Map();
  const uniqueUrls = [...new Set(urls)].filter(Boolean);
  if (uniqueUrls.length === 0) return resolved;

  const pool = getPool();
  if (!pool) return resolved;

  try {
    await ensureTable(pool);
    const { rows } = await pool.query(
      `SELECT url, archive_url, is_dead, checked_at FROM backup_links WHERE url = ANY($1::text[])`,
      [uniqueUrls]
    );

    const staleUrls = [];
    const staleThreshold = new Date(Date.now() - STALE_AFTER_MS);
    for (const row of rows) {
      resolved.set(row.url, row.is_dead ? row.archive_url : row.url);
      // Once dead, archive.org is permanent—never worth rechecking the live url again.
      if (!row.is_dead && (!row.checked_at || new Date(row.checked_at) < staleThreshold)) {
        staleUrls.push(row.url);
      }
    }

    if (staleUrls.length > 0) {
      recheckStaleLinks(pool, staleUrls);
    }
  } catch (error) {
    console.error('[backup-links] resolveLinks failed, links serve unresolved:', error?.message ?? error);
  }

  return resolved;
}

/** Fire-and-forget: never awaited, never throws to the caller. */
function recheckStaleLinks(pool, urls) {
  for (const url of urls) {
    claimAndRecheck(pool, url).catch((error) => {
      console.error(`[backup-links] recheck failed for ${url}:`, error?.message ?? error);
    });
  }
}

/**
 * Claims a stale url before checking it, so a burst of concurrent pageviews for the same stale
 * link doesn't all fire redundant outbound requests at the same third-party site: the UPDATE's
 * WHERE clause only matches (and only one caller's UPDATE affects a row) if it's still stale at
 * the moment this runs. Whoever doesn't affect a row already lost the race to someone else's
 * concurrent claim and just skips—no lock table, no correctness risk either way (Postgres
 * serializes the row writes regardless), this is purely to avoid wasted duplicate checks.
 */
async function claimAndRecheck(pool, url) {
  const staleThreshold = new Date(Date.now() - STALE_AFTER_MS);
  const { rowCount } = await pool.query(
    `UPDATE backup_links SET checked_at = now() WHERE url = $1 AND checked_at < $2`,
    [url, staleThreshold]
  );
  if (rowCount === 0) return;

  const result = await checkUrl(url, {});
  const isDead = !(result.linkStatus === LinkStatus.PROBABLY_VALID || result.linkStatus === LinkStatus.WHITELISTED);
  if (isDead) {
    await pool.query(`UPDATE backup_links SET is_dead = true WHERE url = $1`, [url]);
  }
}
