import { searchSpans } from '../spanSearch.js';

const SPANS_PER_TERM = 20;

/** The terms each search query is matched with: the query itself and its angle's argument (as ref_extractor does). */
function termsFor(conspiracyData, searchQuery) {
  const angle = (conspiracyData.angles ?? []).find((a) => (a.search_queries ?? []).includes(searchQuery));
  return [searchQuery, angle?.argument].filter((term) => typeof term === 'string' && term.trim());
}

/**
 * Spans provider: semantic search over Wikipedia's cited spans
 * (wiki_citation_spans; see spanSearch.js). Each span already carries the
 * text it supports and its citations, so no article is fetched: the matches
 * go in `span_matches` (term → spans, best first), which wiki_filterer
 * passes through and ref_extractor turns into citations. The other fields
 * keep the shape of providers/mediawiki.js, with no pages.
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles with search_queries)
 * @returns {Promise<{ query: string, search_queries: string[], search_query_article_titles: object, span_matches: object, fetched_at: string, page_count: number, pages: [] }>}
 */
export async function fetchWiki(conspiracyData) {
  const searchQueries = (conspiracyData.search_queries?.length > 0)
    ? conspiracyData.search_queries
    : (conspiracyData.angles ?? []).flatMap((angle) => angle.search_queries ?? []).filter(Boolean);

  if (searchQueries.length === 0) {
    throw new Error('No search queries found in conspiracy data.');
  }

  const terms = [...new Set(searchQueries.flatMap((query) => termsFor(conspiracyData, query)))];
  const results = await searchSpans(terms, { limit: SPANS_PER_TERM });
  const spanMatches = Object.fromEntries(terms.map((term, i) => [term, results[i]]));

  // Article titles per query, for the debug page (the spans' articles, best first).
  const searchQueryArticleTitles = {};
  for (const query of searchQueries) {
    const titles = termsFor(conspiracyData, query).flatMap((term) => spanMatches[term].map((span) => span.title));
    searchQueryArticleTitles[query] = [...new Set(titles)];
  }

  return {
    query: conspiracyData.topic ?? '',
    search_queries: searchQueries,
    search_query_article_titles: searchQueryArticleTitles,
    span_matches: spanMatches,
    fetched_at: new Date().toISOString(),
    page_count: 0,
    pages: [],
  };
}
