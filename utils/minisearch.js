/**
 * Shared MiniSearch utilities for citation relevance ranking.
 * Uses Reciprocal Rank Fusion (RRF) across multiple search terms.
 */

import MiniSearch from 'minisearch';

/** Wikipedia section header regex: == Title ==, === Subsection ===, etc. */
const SECTION_HEADER_REGEX = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/gm;

/**
 * Extract section titles from Wikipedia source markup.
 * Strips {{...}} templates and [[...]] links for cleaner search tokens.
 *
 * @param {string} source - Raw wiki markup (page.source)
 * @returns {string} - Space-joined section titles for indexing
 */
export function extractSectionTitles(source) {
  if (!source || typeof source !== 'string') return '';
  const titles = [];
  let match;
  SECTION_HEADER_REGEX.lastIndex = 0;
  while ((match = SECTION_HEADER_REGEX.exec(source)) !== null) {
    const rawTitle = match[2].trim();
    // Strip {{...}} templates and resolve [[link]] / [[link|display]] to display text
    const cleaned = rawTitle
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/\[\[([^|\]]*\|)?([^\]]+)\]\]/g, '$2')
      .trim();
    if (cleaned) titles.push(cleaned);
  }
  return titles.join(' ');
}

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

/**
 * Rank wiki pages by relevance to search terms using MiniSearch + RRF.
 * Indexes on title, extract, and section_titles; returns full page objects.
 *
 * @param {Array<{ title?: string, pageid?: number, extract?: string, source?: string }>} pages - Wiki pages to rank
 * @param {string[]} searchTerms - Terms to search for (topic, arguments, search_queries)
 * @param {object} [options] - Ranking options
 * @param {number} [options.minTermLength] - Skip terms shorter than this (default: 5)
 * @param {number} [options.minTermsMatched] - Require at least this many distinct terms to match (default: 2)
 * @param {number} [options.fuzzy] - MiniSearch fuzzy factor, 0 = exact only (default: 0)
 * @param {number} [options.topk] - Max pages to return (default: 100)
 * @param {number} [options.rrfK] - RRF constant for Reciprocal Rank Fusion (default: 60)
 * @returns {Array} - Ranked page objects sorted by relevance score (best first)
 */
export function rankPagesByRelevance(pages, searchTerms, options = {}) {
  const minTermLength = options.minTermLength ?? 5;
  const minTermsMatched = options.minTermsMatched ?? 2;
  const fuzzy = options.fuzzy ?? 0;
  const topk = options.topk ?? 100;
  const rrfK = options.rrfK ?? 60;

  if (!pages || pages.length === 0) {
    return [];
  }

  const searchIndex = new MiniSearch({
    fields: ['title', 'extract', 'section_titles'],
    storeFields: ['title', 'pageid', 'extract'],
    searchOptions: { combineWith: 'OR', fuzzy },
  });

  pages.forEach((page, index) => {
    const sectionTitles = extractSectionTitles(page.source ?? '');
    searchIndex.add({
      id: String(index),
      title: page.title ?? '',
      pageid: page.pageid ?? null,
      extract: page.extract ?? '',
      section_titles: sectionTitles,
    });
  });

  const termsToSearch = new Set();
  for (const term of searchTerms) {
    if (!term || typeof term !== 'string') continue;
    const words = term.split(/\s+/).filter((word) => word.length >= minTermLength);
    words.forEach((word) => termsToSearch.add(word.toLowerCase()));
  }

  const rrfScoreByIndex = {};
  const matchCountByIndex = {};

  for (const searchTerm of termsToSearch) {
    const results = searchIndex.search(searchTerm, { limit: 5000 });
    results.forEach((result, rankIndex) => {
      const rank = rankIndex + 1;
      const rrfContrib = 1 / (rrfK + rank);
      rrfScoreByIndex[result.id] = (rrfScoreByIndex[result.id] ?? 0) + rrfContrib;
      matchCountByIndex[result.id] = (matchCountByIndex[result.id] ?? 0) + 1;
    });
  }

  const scored = pages
    .map((page, index) => ({
      page,
      score: rrfScoreByIndex[String(index)] ?? 0,
      matchCount: matchCountByIndex[String(index)] ?? 0,
    }))
    .filter((item) => item.matchCount >= minTermsMatched);

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topk)
    .map((item) => item.page);
}
