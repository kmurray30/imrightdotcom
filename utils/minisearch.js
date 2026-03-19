/**
 * Shared MiniSearch utilities for citation relevance ranking.
 * Uses Reciprocal Rank Fusion (RRF) across multiple search terms.
 */

import MiniSearch from 'minisearch';

/**
 * Rank citations by relevance to search terms using MiniSearch + RRF.
 *
 * @param {Array<{ link?: string, blurb?: string, sentence?: string, article_title?: string, section?: string }>} citations - Citations to rank
 * @param {string[]} searchTerms - Terms to search for (claim, arguments, queries)
 * @param {object} [options] - Ranking options
 * @param {number} [options.minTermLength] - Skip terms shorter than this (default: 5)
 * @param {number} [options.minTermsMatched] - Require at least this many distinct terms to match (default: 2)
 * @param {number} [options.fuzzy] - MiniSearch fuzzy factor, 0 = exact only (default: 0)
 * @param {number} [options.topk] - Max citations to return (default: 50)
 * @param {number} [options.rrfK] - RRF constant for Reciprocal Rank Fusion (default: 60)
 * @returns {Array} - Ranked citations sorted by relevance score (best first)
 */
export function rankCitationsByRelevance(citations, searchTerms, options = {}) {
  const minTermLength = options.minTermLength ?? 5;
  const minTermsMatched = options.minTermsMatched ?? 2;
  const fuzzy = options.fuzzy ?? 0;
  const topk = options.topk ?? 50;
  const rrfK = options.rrfK ?? 60;

  if (!citations || citations.length === 0) {
    return [];
  }

  const searchIndex = new MiniSearch({
    fields: ['blurb', 'sentence'],
    storeFields: ['blurb', 'sentence', 'link', 'article_title', 'section'],
    searchOptions: { combineWith: 'OR', fuzzy },
  });

  citations.forEach((citation, index) => {
    searchIndex.add({ id: String(index), ...citation });
  });

  const termsToSearch = new Set();
  for (const term of searchTerms) {
    if (!term || typeof term !== 'string') continue;
    const words = term.split(/\s+/).filter((word) => word.length >= minTermLength);
    words.forEach((word) => termsToSearch.add(word.toLowerCase()));
  }

  const rrfScoreByIndex = {};
  const matchCountByIndex = {};

  for (const term of termsToSearch) {
    const results = searchIndex.search(term, { limit: 5000 });
    results.forEach((result, rankIndex) => {
      const rank = rankIndex + 1;
      const rrfContrib = 1 / (rrfK + rank);
      rrfScoreByIndex[result.id] = (rrfScoreByIndex[result.id] ?? 0) + rrfContrib;
      matchCountByIndex[result.id] = (matchCountByIndex[result.id] ?? 0) + 1;
    });
  }

  const scored = citations
    .map((citation, index) => ({
      citation,
      score: rrfScoreByIndex[String(index)] ?? 0,
      matchCount: matchCountByIndex[String(index)] ?? 0,
    }))
    .filter((item) => item.matchCount >= minTermsMatched);

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topk)
    .map((item) => item.citation);
}
