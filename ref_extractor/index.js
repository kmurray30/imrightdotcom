import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { extractCitationsFromArticleForTerm } from './searchThenExtract.js';
import { checkUrls, LinkStatus } from '../utils/linkChecker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOP_MATCHES_PER_TERM = 5;

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
 * For each search term (query + argument), gets exactly top 5 matches.
 * Every search term is guaranteed representation in the output.
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
  const topMatchesPerTerm = options.top_matches_per_term ?? config.top_matches_per_term ?? TOP_MATCHES_PER_TERM;
  const checkLinks = options.check_links ?? config.check_links ?? true;

  const pages = wikiFilteredData?.pages ?? [];
  const searchQueryArticleTitles = wikiFilteredData?.search_query_article_titles ?? {};
  const searchQueries = wikiFilteredData?.search_queries ?? Object.keys(searchQueryArticleTitles);

  const pagesByTitle = new Map(pages.map((page) => [page.title, page]));

  const seenKeys = new Set();
  const byArticle = {};

  const extractOptions = { citationTypes, excludeUrlPatterns, minTermLength };

  for (const searchQuery of searchQueries) {
    const articleTitles = searchQueryArticleTitles[searchQuery] ?? [];
    const argument = getArgumentForQuery(conspiracyData, searchQuery);
    const searchTerms = [searchQuery];
    if (argument) searchTerms.push(argument);

    for (const searchTerm of searchTerms) {
      if (!searchTerm || typeof searchTerm !== 'string') continue;

      const matchesForTerm = [];
      for (const articleTitle of articleTitles) {
        const page = pagesByTitle.get(articleTitle);
        if (!page?.source) continue;

        const citations = extractCitationsFromArticleForTerm(
          page.source,
          articleTitle,
          searchTerm,
          extractOptions
        );
        matchesForTerm.push(...citations);
      }

      const topMatches = matchesForTerm.slice(0, topMatchesPerTerm);
      for (const citation of topMatches) {
        const key = uniqueCitationKey(citation);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const articleTitle = citation.article_title;
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

  let extractedCount = Object.values(byArticle).reduce(
    (sum, sections) => sum + Object.values(sections).reduce((s, items) => s + items.length, 0),
    0
  );

  if (checkLinks) {
    const allLinks = [...new Set(
      Object.values(byArticle).flatMap((sections) =>
        Object.values(sections).flatMap((items) => items.map((item) => item.link).filter(Boolean))
      )
    )];

    if (allLinks.length > 0) {
      const linkResults = await checkUrls(allLinks, { timeoutMs: 18000, delayMs: 500 });
      const invalidLinks = new Set(
        linkResults.filter((r) => r.linkStatus === LinkStatus.INVALID).map((r) => r.url)
      );

      for (const articleTitle of Object.keys(byArticle)) {
        for (const section of Object.keys(byArticle[articleTitle])) {
          byArticle[articleTitle][section] = byArticle[articleTitle][section].filter(
            (item) => !item.link || !invalidLinks.has(item.link)
          );
          if (byArticle[articleTitle][section].length === 0) {
            delete byArticle[articleTitle][section];
          }
        }
        if (Object.keys(byArticle[articleTitle]).length === 0) {
          delete byArticle[articleTitle];
        }
      }

      extractedCount = Object.values(byArticle).reduce(
        (sum, sections) => sum + Object.values(sections).reduce((s, items) => s + items.length, 0),
        0
      );
    }
  }

  return {
    extracted: byArticle,
    stats: { extractedCount },
  };
}
