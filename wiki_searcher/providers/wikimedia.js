import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { embedTexts } from '../textEmbeddings.js';
import { searchSimilarArticles } from '../../utils/vectorIndex.js';
import { fetchArticleByTitle, toWikiPage } from '../../utils/wikimediaOnDemand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ON_DEMAND_CONCURRENCY = 8; // under Wikimedia Enterprise On-demand's 10 requests/second

/**
 * Wikimedia provider: local vector search (pgvector, no rate limit) finds
 * candidate article titles per query, then Wikimedia Enterprise On-demand
 * (10 req/s, 50K/month free) fetches each candidate's current content.
 * Returns the identical shape as providers/mediawiki.js.
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles with search_queries)
 * @param {object} [options]
 * @param {number} [options.articlesPerQuery] - Max candidate articles per search query (default: 5 from config, or 10)
 * @returns {Promise<{ query: string, search_queries: string[], search_query_article_titles: object, fetched_at: string, page_count: number, pages: Array }>}
 */
export async function fetchWiki(conspiracyData, options = {}) {
  const searchQueries = (conspiracyData.search_queries?.length > 0)
    ? conspiracyData.search_queries
    : (conspiracyData.angles ?? []).flatMap((angle) => angle.search_queries ?? []).filter(Boolean);

  if (searchQueries.length === 0) {
    throw new Error('No search queries found in conspiracy data.');
  }

  // Shares wiki_searcher/config.yaml with providers/mediawiki.js so both
  // providers fetch a comparable number of candidates per query.
  const configPath = path.join(__dirname, '..', 'config.yaml');
  const config = fs.existsSync(configPath)
    ? yaml.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  const articlesPerQuery = options.articlesPerQuery ?? config.articles_per_query ?? 10;

  // Step 1: embed every query in one batched model call (far cheaper than one
  // call per query — see embedTexts), then vector-search them concurrently.
  // No external rate limit here — a local model call plus Postgres queries.
  const embeddings = await embedTexts(searchQueries);
  const titleLists = await Promise.all(
    embeddings.map(async (embedding) => {
      const matches = await searchSimilarArticles(embedding, articlesPerQuery);
      return matches.map((match) => match.title);
    })
  );

  const searchQueryArticleTitles = {};
  const allTitles = new Set();
  for (let i = 0; i < searchQueries.length; i++) {
    searchQueryArticleTitles[searchQueries[i]] = titleLists[i];
    titleLists[i].forEach((title) => allTitles.add(title));
  }

  // Step 2: fetch full content for the deduplicated candidate titles via
  // Wikimedia Enterprise On-demand, one call per title, at most
  // ON_DEMAND_CONCURRENCY in flight — a run has up to ~40 candidates, and
  // firing them all at once would blow through On-demand's 10 req/s limit.
  // A title that still fails after callExternalApi's retries is skipped (like
  // a title with no exact match), so one bad fetch doesn't sink the whole run.
  const pagesByTitle = new Map();
  const titlesToFetch = Array.from(allTitles);
  let nextIndex = 0;
  async function fetchWorker() {
    while (nextIndex < titlesToFetch.length) {
      const title = titlesToFetch[nextIndex++];
      try {
        const article = await fetchArticleByTitle(title);
        if (article) pagesByTitle.set(title, toWikiPage(article));
      } catch (error) {
        console.warn(`[wiki_searcher/wikimedia] skipping "${title}": on-demand fetch failed — ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ON_DEMAND_CONCURRENCY, titlesToFetch.length) }, fetchWorker));

  const query = conspiracyData.topic ?? '';

  // Merge pages, tracking search_queries_hit per page (mirrors providers/mediawiki.js).
  const pagesById = new Map();
  for (let i = 0; i < searchQueries.length; i++) {
    const searchQuery = searchQueries[i];
    for (const title of titleLists[i]) {
      const page = pagesByTitle.get(title);
      if (!page) continue; // vector index had it, but no exact On-demand match (deleted/renamed since last embed)
      if (!pagesById.has(page.pageid)) {
        pagesById.set(page.pageid, { ...page, search_queries_hit: [searchQuery] });
      } else {
        pagesById.get(page.pageid).search_queries_hit.push(searchQuery);
      }
    }
  }

  const pages = Array.from(pagesById.values());

  return {
    query,
    search_queries: searchQueries,
    search_query_article_titles: searchQueryArticleTitles,
    fetched_at: new Date().toISOString(),
    page_count: pages.length,
    pages,
  };
}
