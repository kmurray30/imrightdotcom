import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Wiki searcher module: fetches Wikipedia articles via MediaWiki API.
 * Uses search queries from conspirator output, fetches for each query,
 * and returns a deduplicated union of all articles.
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles with search_queries)
 * @param {object} [options] - Optional config
 * @param {number} [options.articlesPerQuery] - Max articles per search query (default: 5 from config, or 10)
 * @returns {Promise<{ query: string, search_queries: string[], search_query_article_titles: object, fetched_at: string, page_count: number, pages: object[] }>}
 */
export async function fetchWiki(conspiracyData, options = {}) {

  const EXTRACT_CHARS_PER_PAGE = 1200;
  const WIKI_API = 'https://en.wikipedia.org/w/api.php';
  const USER_AGENT = 'imright-wiki-fetcher/1.0 (educational use)';

  const searchQueries = (conspiracyData.angles ?? []).flatMap((angle) => angle.search_queries ?? []).filter(Boolean);

  if (searchQueries.length === 0) {
    throw new Error('No search queries found in conspiracy data.');
  }

  const configPath = path.join(__dirname, 'config.yaml');
  const config = fs.existsSync(configPath)
    ? yaml.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  const articlesPerQuery = options.articlesPerQuery ?? config.articles_per_query ?? 10;

  async function fetchFromMediaWiki(params) {
    const url = new URL(WIKI_API);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });

    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!response.ok) {
      throw new Error(`MediaWiki API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async function searchPages(query, limit) {
    const data = await fetchFromMediaWiki({
      action: 'query',
      list: 'search',
      srsearch: query,
      format: 'json',
      srlimit: limit,
    });

    return data.query.search.map((result) => ({
      title: result.title,
      pageid: result.pageid,
      snippet: result.snippet,
      size: result.size,
      wordcount: result.wordcount,
    }));
  }

  async function fetchPageData(searchResults) {
    if (searchResults.length === 0) return [];

    const data = await fetchFromMediaWiki({
      action: 'query',
      prop: 'extracts|revisions',
      exintro: false,
      explaintext: true,
      exchars: EXTRACT_CHARS_PER_PAGE,
      rvprop: 'ids|timestamp|content',
      rvslots: 'main',
      titles: searchResults.map((page) => page.title).join('|'),
      format: 'json',
    });

    const pages = data.query.pages;
    const results = [];

    for (const pageId of Object.keys(pages)) {
      const page = pages[pageId];
      const revision = page.revisions?.[0];
      const mainSlot = revision?.slots?.main;
      const source = mainSlot?.['*'] ?? mainSlot?.content ?? '';

      results.push({
        pageid: page.pageid,
        title: page.title,
        extract: page.extract?.trim() ?? '',
        source: source.trim(),
        revision_id: revision?.revid,
        last_modified: revision?.timestamp,
      });
    }

    return results;
  }

  const query = conspiracyData.topic ?? '';

  // Run all search queries concurrently; each does searchPages + fetchPageData
  const pageLists = await Promise.all(
    searchQueries.map(async (searchQuery) => {
      const searchResults = await searchPages(searchQuery, articlesPerQuery);
      if (searchResults.length === 0) return [];

      const pageData = await fetchPageData(searchResults);
      const searchByTitle = Object.fromEntries(searchResults.map((r) => [r.title, r]));

      return pageData.map((page) => {
        const searchMeta = searchByTitle[page.title];
        return {
          title: page.title,
          pageid: page.pageid,
          extract: page.extract,
          source: page.source,
          revision_id: page.revision_id,
          last_modified: page.last_modified,
          ...(searchMeta && {
            snippet: searchMeta.snippet,
            size_bytes: searchMeta.size,
            wordcount: searchMeta.wordcount,
          }),
        };
      });
    })
  );

  // Build search_query_article_titles: query -> [titles]
  const searchQueryArticleTitles = {};
  for (let i = 0; i < searchQueries.length; i++) {
    searchQueryArticleTitles[searchQueries[i]] = pageLists[i].map((page) => page.title);
  }

  // Merge pages, tracking search_queries_hit per page
  const pagesById = new Map();
  for (let i = 0; i < searchQueries.length; i++) {
    const searchQuery = searchQueries[i];
    for (const page of pageLists[i]) {
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
