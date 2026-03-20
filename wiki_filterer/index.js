import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { rankPagesByRelevance } from '../utils/minisearch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find the angle (argument) that contains the given search query.
 */
function getArgumentForQuery(conspiracyData, searchQuery) {
  for (const angle of conspiracyData.angles ?? []) {
    if ((angle.search_queries ?? []).includes(searchQuery)) {
      return angle.argument ?? '';
    }
  }
  return '';
}

/**
 * Filters Wikipedia articles for relevance. Each search query is an independent pipeline:
 * filter that query's articles by relevance to its argument, keep top N per query.
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles with argument, search_queries)
 * @param {object} wikiFetchedData - Output from wiki_searcher (query, pages, search_query_article_titles)
 * @param {object} [options] - Optional config overrides (min_terms_matched, topk_per_query, etc.)
 * @returns {Promise<{ query: string, search_queries: string[], search_query_article_titles: object, arguments: string[], fetched_at: string|null, filtered_at: string, page_count: number, pages: object[] }>}
 */
export async function filterWiki(conspiracyData, wikiFetchedData, options = {}) {
  const configPath = path.join(__dirname, 'config.yaml');
  const config = fs.existsSync(configPath)
    ? yaml.parse(fs.readFileSync(configPath, 'utf8'))
    : {};

  const argumentsList = (conspiracyData.angles ?? []).map((angle) => angle.argument).filter(Boolean);

  if (argumentsList.length === 0) {
    throw new Error('No arguments found in conspiracy data.');
  }

  const pagesById = new Map(
    (wikiFetchedData?.pages ?? []).map((page) => [page.pageid, page])
  );

  if (pagesById.size === 0) {
    throw new Error('No pages found in wiki data or invalid structure.');
  }

  const minTermsMatched = options.min_terms_matched ?? config.min_terms_matched ?? 2;
  const minTermLength = options.min_term_length ?? config.min_term_length ?? 3;
  const minisearchFuzzy = options.minisearch_fuzzy ?? config.minisearch_fuzzy ?? 0;
  const topkPerQuery = options.topk_per_query ?? config.topk_per_query ?? 10;
  const rrfK = options.rrf_k ?? config.rrf_k ?? 60;

  const rawSearchQueryArticleTitles = wikiFetchedData.search_query_article_titles ?? {};
  const searchQueries = wikiFetchedData.search_queries ?? Object.keys(rawSearchQueryArticleTitles);
  const searchQueryArticleTitles = {};
  const keptPageIds = new Set();

  for (const searchQuery of searchQueries) {
    const articleTitles = rawSearchQueryArticleTitles[searchQuery] ?? [];
    if (articleTitles.length === 0) continue;

    const argument = getArgumentForQuery(conspiracyData, searchQuery);
    const searchTerms = [searchQuery];
    if (argument) searchTerms.push(argument);

    const pagesForQuery = articleTitles
      .map((title) => Array.from(pagesById.values()).find((page) => page.title === title))
      .filter(Boolean);

    const filteredForQuery = rankPagesByRelevance(pagesForQuery, searchTerms, {
      minTermsMatched,
      minTermLength,
      fuzzy: minisearchFuzzy,
      topk: topkPerQuery,
      rrfK,
    });

    searchQueryArticleTitles[searchQuery] = filteredForQuery.map((page) => page.title);
    for (const page of filteredForQuery) {
      keptPageIds.add(page.pageid);
    }
  }

  const filteredPages = Array.from(pagesById.values()).filter((page) =>
    keptPageIds.has(page.pageid)
  );

  return {
    query: wikiFetchedData.query ?? conspiracyData.topic ?? '',
    search_queries: searchQueries,
    search_query_article_titles: searchQueryArticleTitles,
    arguments: argumentsList,
    fetched_at: wikiFetchedData.fetched_at ?? null,
    filtered_at: new Date().toISOString(),
    page_count: filteredPages.length,
    pages: filteredPages,
  };
}
