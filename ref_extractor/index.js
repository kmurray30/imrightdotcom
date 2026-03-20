import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { rankCitationsByRelevance } from '../utils/minisearch.js';
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

  const filtered = rankCitationsByRelevance(withLink, searchTerms, {
    minTermLength,
    minTermsMatched,
    fuzzy: minisearchFuzzy,
    topk,
    rrfK,
  });

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
