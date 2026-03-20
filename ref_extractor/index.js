import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { extractCitationsFromArticle } from './searchThenExtract.js';

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
 * Key for deduping citations.
 */
function uniqueCitationKey(citation) {
  if (citation.link && citation.title) {
    return citation.link + '|' + citation.title;
  }
  return citation.link || citation.title || 'no-link';
}

/**
 * Extracts relevant citations from filtered wiki articles.
 * Per-query pipeline: for each search query, search its articles for factoids,
 * find the first citation in the same paragraph, and extract.
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles)
 * @param {object} wikiFilteredData - Output from wiki_filterer (pages, search_query_article_titles)
 * @param {object} [options] - Optional config overrides (citation_types, exclude_url_patterns, etc.)
 * @returns {Promise<{ extracted: { [articleTitle]: { [section]: Array<{ link, title, content }> } }, stats: { extractedCount: number } }>}
 */
export async function extract(conspiracyData, wikiFilteredData, options = {}) {
  const configPath = path.join(__dirname, 'config.yaml');
  const config = fs.existsSync(configPath)
    ? yaml.parse(fs.readFileSync(configPath, 'utf8'))
    : {};

  const citationTypes = new Set(
    (options.citation_types ?? config.citation_types ?? []).map((type) => type.toLowerCase())
  );
  const excludeUrlPatterns = (options.exclude_url_patterns ?? config.exclude_url_patterns ?? []).map(
    (pattern) => pattern.toLowerCase()
  );
  const minTermLength = options.min_term_length ?? config.min_term_length ?? 5;

  const pages = wikiFilteredData?.pages ?? [];
  const searchQueryArticleTitles = wikiFilteredData?.search_query_article_titles ?? {};
  const searchQueries = wikiFilteredData?.search_queries ?? Object.keys(searchQueryArticleTitles);

  const pagesByTitle = new Map(pages.map((page) => [page.title, page]));

  const seenKeys = new Set();
  const byArticle = {};

  for (const searchQuery of searchQueries) {
    const articleTitles = searchQueryArticleTitles[searchQuery] ?? [];
    const argument = getArgumentForQuery(conspiracyData, searchQuery);
    const searchTerms = [searchQuery];
    if (argument) searchTerms.push(argument);

    for (const articleTitle of articleTitles) {
      const page = pagesByTitle.get(articleTitle);
      if (!page?.source) continue;

      const citations = extractCitationsFromArticle(page.source, articleTitle, searchTerms, {
        citationTypes,
        excludeUrlPatterns,
        minTermLength,
      });

      for (const citation of citations) {
        const key = uniqueCitationKey(citation);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const section = citation.section;
        if (!byArticle[articleTitle]) byArticle[articleTitle] = {};
        if (!byArticle[articleTitle][section]) byArticle[articleTitle][section] = [];
        byArticle[articleTitle][section].push({
          link: citation.link,
          title: citation.title,
          content: citation.content,
        });
      }
    }
  }

  const extractedCount = Object.values(byArticle).reduce(
    (sum, sections) => sum + Object.values(sections).reduce((s, items) => s + items.length, 0),
    0
  );

  return {
    extracted: byArticle,
    stats: { extractedCount },
  };
}
