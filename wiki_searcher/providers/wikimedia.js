import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { embedText } from '../textEmbeddings.js';
import { searchSimilarArticles } from '../../utils/vectorIndex.js';
import { fetchArticleByTitle, toWikiPage } from '../../utils/wikimediaOnDemand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // Step 1: embed + vector-search each query concurrently. No external rate
  // limit here — this is a local model call plus a Postgres query.
  const titleLists = await Promise.all(
    searchQueries.map(async (searchQuery) => {
      const embedding = await embedText(searchQuery);
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
  // Wikimedia Enterprise On-demand, one call per title, all concurrent.
  const pagesByTitle = new Map();
  await Promise.all(
    Array.from(allTitles).map(async (title) => {
      const article = await fetchArticleByTitle(title);
      if (article) pagesByTitle.set(title, toWikiPage(article));
    })
  );

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
