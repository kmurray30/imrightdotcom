#!/usr/bin/env node
/**
 * Daily refresh: asks MediaWiki (free, list=recentchanges — a lightweight
 * metadata endpoint, separate from the rate-limited full-text search) which
 * article-namespace pages changed since the last successful run, fetches
 * each one's current content via Wikimedia Enterprise On-demand, and
 * re-embeds it.
 *
 * Checkpointed, not a fixed lookback window: the "since" timestamp comes
 * from wiki_refresh_checkpoint (see schema/wiki_refresh_checkpoint.sql), not
 * "now minus N hours". That means a missed or failed run doesn't create a
 * permanent gap — the next run picks up exactly where the last *successful*
 * one left off, however long ago that was. The checkpoint only advances
 * after a run completes without a fatal error; a crash mid-run leaves it
 * where it was, so the retry re-covers the same window (safe and cheap,
 * since upsertArticleEmbeddings skips articles that are already current).
 * On the very first run ever (no checkpoint row yet), falls back to the
 * lookbackHours argument.
 *
 * This is what keeps the vector index current without ever touching the
 * live request path — run it on a schedule (Railway cron, or a Routine),
 * independent of any user interaction.
 *
 * Caveat: MediaWiki's recentchanges table itself doesn't retain forever —
 * if the checkpoint ever falls far enough behind (e.g. weeks of downtime),
 * requesting that far back may return an incomplete picture regardless of
 * this script's own logic. Fine for occasional missed runs; not a
 * substitute for noticing if the refresh has been broken for a long time.
 *
 * Before relying on this in production: probe list=recentchanges the same
 * way misc_scripts/probe-wiki-rate-limit.js probes list=search — it's a
 * different endpoint and hasn't been measured yet.
 *
 * Usage: node wiki_searcher/scripts/refresh-daily.js [lookbackHours=24]
 *   (lookbackHours only matters on the very first run, before a checkpoint exists)
 */
import { loadEnv } from '../../imright/load-env.js';
import { callExternalApi, HttpStatusError, timeoutSignal } from '../../utils/external-api.js';
import { fetchArticleByTitle, toWikiPage } from '../../utils/wikimediaOnDemand.js';
import { upsertArticleEmbeddings } from '../embeddingIndex.js';
import { getPool } from '../../imright/scripts/db.js';

loadEnv();

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'imright-wiki-refresh/1.0 (educational use)';
const RC_TIMEOUT_MS = 15_000;
const RC_BATCH_LIMIT = 500; // MediaWiki's max rclimit per request
const REFRESH_CONCURRENCY = 4;

const firstRunLookbackHours = Number(process.argv[2]) || 24;

/** Last successful run's timestamp, or null if this is the first run ever. */
async function getCheckpoint() {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set; cannot read the refresh checkpoint.');
  const { rows } = await pool.query('SELECT last_synced_at FROM wiki_refresh_checkpoint WHERE id = TRUE');
  return rows.length > 0 ? new Date(rows[0].last_synced_at) : null;
}

/** Advances the checkpoint — only call this after a run completes successfully. */
async function setCheckpoint(timestamp) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO wiki_refresh_checkpoint (id, last_synced_at) VALUES (TRUE, $1)
     ON CONFLICT (id) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at`,
    [timestamp.toISOString()]
  );
}

async function fetchRecentChangesPage(rcstart, rccontinue) {
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'recentchanges');
  url.searchParams.set('rcnamespace', '0');
  url.searchParams.set('rctype', 'edit|new');
  url.searchParams.set('rcprop', 'title');
  url.searchParams.set('rclimit', String(RC_BATCH_LIMIT));
  url.searchParams.set('rcdir', 'newer');
  url.searchParams.set('rcstart', rcstart);
  url.searchParams.set('format', 'json');
  if (rccontinue) url.searchParams.set('rccontinue', rccontinue);

  return callExternalApi({
    service: 'mediawiki',
    operation: 'recentchanges',
    pipelineStep: 'wiki_refresh',
    fn: async () => {
      const response = await fetch(url.toString(), {
        headers: { 'User-Agent': USER_AGENT },
        signal: timeoutSignal(RC_TIMEOUT_MS),
      });
      if (!response.ok) {
        const retryAfterHeader = response.headers.get('retry-after');
        throw new HttpStatusError(response.status, `MediaWiki recentchanges error: ${response.status}`, {
          retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : undefined,
        });
      }
      return response.json();
    },
  });
}

/** Every distinct article-namespace title touched since `since` (a Date). */
async function getChangedTitlesSince(since) {
  const titles = new Set();
  let rccontinue;
  const rcstart = since.toISOString();

  do {
    const data = await fetchRecentChangesPage(rcstart, rccontinue?.rccontinue);
    for (const change of data.query?.recentchanges ?? []) {
      titles.add(change.title);
    }
    rccontinue = data.continue;
  } while (rccontinue);

  return Array.from(titles);
}

async function processInBatches(items, worker, concurrency) {
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runNext));
}

async function main() {
  // Captured before querying, not after processing finishes — safe even if
  // edits land while this run is in progress, since the next run's window
  // starts from here, not from whenever this run happened to finish.
  const runStartedAt = new Date();

  const checkpoint = await getCheckpoint();
  const since = checkpoint ?? new Date(Date.now() - firstRunLookbackHours * 60 * 60 * 1000);
  console.log(
    checkpoint
      ? `Finding articles changed since last successful run (${since.toISOString()})...`
      : `No checkpoint yet — first run, using ${firstRunLookbackHours}h lookback (${since.toISOString()})...`
  );

  const titles = await getChangedTitlesSince(since);
  console.log(`Found ${titles.length} changed titles. Re-embedding...`);

  let updated = 0;
  let alreadyCurrent = 0;
  let noMatch = 0;
  await processInBatches(
    titles,
    async (title) => {
      const article = await fetchArticleByTitle(title);
      if (!article) {
        noMatch++; // deleted, moved, or otherwise no longer an exact match
        return;
      }
      const page = toWikiPage(article);
      const result = await upsertArticleEmbeddings({
        title: page.title,
        wikitext: page.source,
        versionIdentifier: page.revision_id,
      });
      if (result.skipped) {
        alreadyCurrent++; // recentchanges listed it, but this exact revision is already indexed
      } else {
        updated++;
        if (updated % 100 === 0) console.log(`  ...${updated} re-embedded`);
      }
    },
    REFRESH_CONCURRENCY
  );

  // Only advance the checkpoint once everything above has actually succeeded —
  // a thrown error skips this, so the next run retries from the same `since`.
  await setCheckpoint(runStartedAt);

  console.log(`\nDone. Re-embedded ${updated} articles, ${alreadyCurrent} already current, ${noMatch} no longer found.`);
  console.log(`Checkpoint advanced to ${runStartedAt.toISOString()}.`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
