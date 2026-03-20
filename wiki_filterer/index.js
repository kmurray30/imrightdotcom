import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { rankPagesByRelevance } from '../utils/minisearch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Filters Wikipedia articles for relevance to arguments from conspiracy data.
 * Uses MiniSearch + RRF for lexical relevance ranking (no LLM).
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles with argument)
 * @param {object} wikiFetchedData - Output from wiki_searcher (query, pages)
 * @param {object} [options] - Optional config overrides (min_terms_matched, topk, etc.)
 * @returns {Promise<{ query: string, arguments: string[], fetched_at: string|null, filtered_at: string, page_count: number, pages: object[] }>}
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

  const pages = wikiFetchedData?.pages ?? [];

  if (!pages || !Array.isArray(pages) || pages.length === 0) {
    throw new Error('No pages found in wiki data or invalid structure.');
  }

  // Build search terms from topic, arguments, and search_queries (same pattern as article_extractor)
  const searchTerms = [conspiracyData.topic ?? wikiFetchedData.query ?? ''];
  for (const angle of conspiracyData.angles ?? []) {
    if (angle.argument) searchTerms.push(angle.argument);
    for (const query of angle.search_queries ?? []) {
      if (query) searchTerms.push(query);
    }
  }

  const minTermsMatched = options.min_terms_matched ?? config.min_terms_matched ?? 2;
  const minTermLength = options.min_term_length ?? config.min_term_length ?? 5;
  const minisearchFuzzy = options.minisearch_fuzzy ?? config.minisearch_fuzzy ?? 0;
  const topk = options.topk ?? config.topk ?? 100;
  const rrfK = options.rrf_k ?? config.rrf_k ?? 60;

  const filteredPages = rankPagesByRelevance(pages, searchTerms, {
    minTermsMatched,
    minTermLength,
    fuzzy: minisearchFuzzy,
    topk,
    rrfK,
  });

  return {
    query: wikiFetchedData.query ?? conspiracyData.topic ?? '',
    arguments: argumentsList,
    fetched_at: wikiFetchedData.fetched_at ?? null,
    filtered_at: new Date().toISOString(),
    page_count: filteredPages.length,
    pages: filteredPages,
  };
}
