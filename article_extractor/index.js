import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import MiniSearch from 'minisearch';
import { parseRefs } from './parser/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Key for deduping citations (refs = each in-text reference; citations = unique sources).
 */
function uniqueCitationKey(citation) {
  if (citation.link && citation.blurb) {
    return citation.link + '|' + citation.blurb;
  }
  return citation.link || citation.blurb || 'no-link-' + citation.type;
}

/**
 * Extracts relevant citations from filtered wiki articles.
 * Filters by citation type whitelist, link presence, and minisearch relevance.
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles)
 * @param {object} wikiFilteredData - Output from wiki_filterer (pages)
 * @param {object} [options] - Optional config overrides (prior_sentences, citation_types, etc.)
 * @returns {Promise<{ [articleTitle]: { [section]: Array<{ link, blurb, sentence }> } }>}
 */
export async function extract(conspiracyData, wikiFilteredData, options = {}) {
  const configPath = path.join(__dirname, 'config.yaml');
  const config = fs.existsSync(configPath)
    ? yaml.parse(fs.readFileSync(configPath, 'utf8'))
    : {};

  const priorSentences = options.prior_sentences ?? config.prior_sentences ?? 1;
  const citationTypes = new Set(
    (options.citation_types ?? config.citation_types ?? []).map((type) => type.toLowerCase())
  );
  const excludeUrlPatterns = (options.exclude_url_patterns ?? config.exclude_url_patterns ?? []).map(
    (pattern) => pattern.toLowerCase()
  );
  const minTermsMatched = options.min_terms_matched ?? config.min_terms_matched ?? 2;
  const minTermLength = options.min_term_length ?? config.min_term_length ?? 5;
  const minisearchFuzzy = options.minisearch_fuzzy ?? config.minisearch_fuzzy ?? 0;
  const topk = options.topk ?? config.topk ?? 50;
  const rrfK = options.rrf_k ?? config.rrf_k ?? 60;

  const claim = conspiracyData.topic ?? wikiFilteredData.query ?? '';
  const pages = wikiFilteredData?.pages ?? [];

  const searchTerms = [conspiracyData.topic ?? claim];
  for (const angle of conspiracyData.angles ?? []) {
    if (angle.argument) searchTerms.push(angle.argument);
    for (const query of angle.search_queries ?? []) {
      if (query) searchTerms.push(query);
    }
  }

  const allCitations = [];
  for (const page of pages) {
    const source = page.source ?? '';
    const title = page.title ?? 'Unknown';
    const refs = parseRefs(source, title, priorSentences, null);
    allCitations.push(...refs);
  }

  const withLink = allCitations.filter((citation) => {
    if (!citation.link || !citation.link.startsWith('http') || !citationTypes.has(citation.type)) {
      return false;
    }
    const linkLower = citation.link.toLowerCase();
    if (excludeUrlPatterns.some((pattern) => linkLower.includes(pattern))) {
      return false;
    }
    return true;
  });

  const searchIndex = new MiniSearch({
    fields: ['blurb', 'sentence'],
    storeFields: ['blurb', 'sentence', 'link', 'article_title', 'section'],
    searchOptions: { combineWith: 'OR', fuzzy: minisearchFuzzy },
  });

  withLink.forEach((citation, index) => {
    searchIndex.add({ id: String(index), ...citation });
  });

  const termsToSearch = new Set();
  for (const term of searchTerms) {
    if (!term || typeof term !== 'string') continue;
    const words = term.split(/\s+/).filter((word) => word.length >= minTermLength);
    words.forEach((word) => termsToSearch.add(word.toLowerCase()));
  }

  const RRF_K = rrfK;
  const rrfScoreByIndex = {};
  const matchCountByIndex = {};

  for (const term of termsToSearch) {
    const results = searchIndex.search(term, { limit: 5000 });
    results.forEach((result, index) => {
      const rank = index + 1;
      const rrfContrib = 1 / (RRF_K + rank);
      rrfScoreByIndex[result.id] = (rrfScoreByIndex[result.id] ?? 0) + rrfContrib;
      matchCountByIndex[result.id] = (matchCountByIndex[result.id] ?? 0) + 1;
    });
  }

  const scored = withLink
    .map((citation, index) => ({
      citation,
      score: rrfScoreByIndex[String(index)] ?? 0,
      matchCount: matchCountByIndex[String(index)] ?? 0,
    }))
    .filter((item) => item.matchCount >= minTermsMatched);

  const filtered = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topk)
    .map((item) => item.citation);

  const byArticle = {};
  for (const citation of filtered) {
    const articleTitle = citation.article_title;
    const section = citation.section;
    if (!byArticle[articleTitle]) byArticle[articleTitle] = {};
    if (!byArticle[articleTitle][section]) byArticle[articleTitle][section] = [];
    byArticle[articleTitle][section].push({
      link: citation.link,
      blurb: citation.blurb,
      sentence: citation.sentence,
    });
  }

  return byArticle;
}
