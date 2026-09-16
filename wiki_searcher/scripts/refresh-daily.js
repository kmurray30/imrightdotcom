#!/usr/bin/env node
/**
 * Daily refresh: asks MediaWiki (free, list=recentchanges — a lightweight
 * metadata endpoint, separate from the rate-limited full-text search) which
 * article-namespace pages changed in the lookback window, fetches each one's
 * current content via Wikimedia Enterprise On-demand, and re-embeds it.
 *
 * This is what keeps the vector index current without ever touching the
 * live request path — run it on a schedule (Railway cron, or a Routine),
 * independent of any user interaction.
 *
 * Before relying on this in production: probe list=recentchanges the same
 * way misc_scripts/probe-wiki-rate-limit.js probes list=search — it's a
 * different endpoint and hasn't been measured yet.
 *
 * Usage: node wiki_searcher/scripts/refresh-daily.js [lookbackHours=24]
 */
import { loadEnv } from '../../imright/load-env.js';
import { callExternalApi, HttpStatusError, timeoutSignal } from '../../utils/external-api.js';
import { fetchArticleByTitle, toWikiPage } from '../../utils/wikimediaOnDemand.js';
import { upsertArticleEmbeddings } from '../embeddingIndex.js';

loadEnv();

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'imright-wiki-refresh/1.0 (educational use)';
const RC_TIMEOUT_MS = 15_000;
const RC_BATCH_LIMIT = 500; // MediaWiki's max rclimit per request
const REFRESH_CONCURRENCY = 4;

const lookbackHours = Number(process.argv[2]) || 24;

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
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  console.log(`Finding articles changed since ${since.toISOString()}...`);

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

  console.log(`\nDone. Re-embedded ${updated} articles, ${alreadyCurrent} already current, ${noMatch} no longer found.`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
