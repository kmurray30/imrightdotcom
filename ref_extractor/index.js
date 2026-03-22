import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { extractCitationsFromArticleForTerm } from './searchThenExtract.js';
import { checkUrl, LinkStatus } from '../utils/linkChecker.js';

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
 * Check multiple URLs concurrently (no delay).
 * Returns array of { url, linkStatus, issueType, detail, timeMs }.
 */
async function checkUrlsConcurrent(urls, options) {
  const results = await Promise.all(
    urls.map(async (url) => {
      const start = performance.now();
      const result = await checkUrl(url, options);
      const timeMs = performance.now() - start;
      return { url, ...result, timeMs };
    })
  );
  return results;
}

/** Compute median of numeric array. */
function median(values) {
  if (!values?.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Extracts relevant citations from filtered wiki articles.
 * For each search term (query + argument), gets up to top_matches_per_term valid matches.
 * Link checks run concurrently; terms below min_refs_per_term get one retry round.
 *
 * @param {object} conspiracyData - Output from conspirator (topic, angles)
 * @param {object} wikiFilteredData - Output from wiki_filterer (pages, search_query_article_titles)
 * @param {object} [options] - Optional config overrides
 * @returns {Promise<{ extracted, stats: { extractedCount, linkStats } }>}
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
  const minRefsPerTerm = options.min_refs_per_term ?? config.min_refs_per_term ?? 2;
  const linkCheckRetries = options.link_check_retries ?? config.link_check_retries ?? 1;
  const slug = options.slug ?? null;

  const pages = wikiFilteredData?.pages ?? [];
  const searchQueryArticleTitles = wikiFilteredData?.search_query_article_titles ?? {};
  const searchQueries = wikiFilteredData?.search_queries ?? Object.keys(searchQueryArticleTitles);

  const pagesByTitle = new Map(pages.map((page) => [page.title, page]));

  const extractOptions = { citationTypes, excludeUrlPatterns, minTermLength };
  const linkCheckOptions = { timeoutMs: 18000 };

  const deadLinks = [];
  let retriesUsed = 0;
  const linkAssessments = []; // { url, linkStatus, issueType, detail, timeMs, round }

  // Build term -> ranked citations
  const termToCitations = [];
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

      termToCitations.push({ searchTerm, citations: matchesForTerm });
    }
  }

  const seenKeys = new Set();
  const byTerm = {};
  const validityCache = new Map(); // url -> true | false

  function addCitation(citation, searchTerm, rank) {
    const key = uniqueCitationKey(citation);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);

    if (!byTerm[searchTerm]) byTerm[searchTerm] = [];
    byTerm[searchTerm].push({
      link: citation.link,
      title: citation.title,
      content: citation.content,
      article_title: citation.article_title,
      rank,
    });
    return true;
  }

  // Round 1: collect top k links per term, check all concurrently
  const round1Candidates = [];
  for (const { searchTerm, citations } of termToCitations) {
    const batch = [];
    let count = 0;
    for (const citation of citations) {
      if (count >= topMatchesPerTerm) break;
      const key = uniqueCitationKey(citation);
      if (seenKeys.has(key)) continue;
      if (citation.link) {
        batch.push(citation);
        count++;
      } else if (addCitation(citation, searchTerm, count + 1)) {
        count++;
      }
    }
    round1Candidates.push({ searchTerm, citations, batch });
  }

  const urlToTermRanks = new Map();
  for (const { searchTerm, batch } of round1Candidates) {
    batch.forEach((c, index) => {
      if (c.link) {
        const list = urlToTermRanks.get(c.link) ?? [];
        list.push({ searchTerm, rank: index + 1 });
        urlToTermRanks.set(c.link, list);
      }
    });
  }

  if (checkLinks) {
    const allUrlsRound1 = [...new Set(round1Candidates.flatMap(({ batch }) => batch.map((c) => c.link).filter(Boolean)))];
    if (allUrlsRound1.length > 0) {
      const results = await checkUrlsConcurrent(allUrlsRound1, linkCheckOptions);
      for (const result of results) {
        linkAssessments.push({ url: result.url, linkStatus: result.linkStatus, issueType: result.issueType, detail: result.detail, timeMs: result.timeMs, round: 1 });
        validityCache.set(result.url, result.linkStatus !== LinkStatus.INVALID);
        if (result.linkStatus === LinkStatus.INVALID) {
          const termRanks = urlToTermRanks.get(result.url) ?? [];
          for (const { searchTerm, rank } of termRanks) {
            deadLinks.push({ url: result.url, reason: result.detail || result.issueType, searchTerm, rank });
          }
        }
      }
    }
  }

  // Apply round 1 results: for each term, add first k valid in rank order (or all if !checkLinks)
  const failedTerms = [];
  for (const { searchTerm, citations, batch } of round1Candidates) {
    let validAddedForTerm = 0;
    for (let index = 0; index < batch.length; index++) {
      const citation = batch[index];
      if (!citation.link) continue;
      const rank = index + 1;
      const isValid = checkLinks ? validityCache.get(citation.link) : true;
      if (isValid === true && addCitation(citation, searchTerm, rank)) validAddedForTerm++;
    }
    if (checkLinks && validAddedForTerm < minRefsPerTerm && citations.length > topMatchesPerTerm) {
      failedTerms.push({ searchTerm, citations });
    }
  }

  // Round 2 (retry): for failed terms, get next k links (skip first batch), check concurrently
  if (checkLinks && linkCheckRetries > 0 && failedTerms.length > 0) {
    retriesUsed = 1;

    const round2Candidates = [];
    const round2UrlToTermRanks = new Map();
    for (const { searchTerm, citations } of failedTerms) {
      const round1Batch = round1Candidates.find((r) => r.searchTerm === searchTerm)?.batch ?? [];
      const round1Keys = new Set(round1Batch.map(uniqueCitationKey));

      const batch = [];
      let position = round1Batch.length;
      for (const citation of citations) {
        if (batch.length >= topMatchesPerTerm) break;
        const key = uniqueCitationKey(citation);
        if (round1Keys.has(key) || seenKeys.has(key)) continue;
        position++;
        if (citation.link) {
          batch.push(citation);
          const list = round2UrlToTermRanks.get(citation.link) ?? [];
          list.push({ searchTerm, rank: position });
          round2UrlToTermRanks.set(citation.link, list);
        } else if (addCitation(citation, searchTerm, position)) {
          // non-link citation added
        }
      }
      round2Candidates.push({ searchTerm, citations, batch });
    }

    const allUrlsRound2 = [...new Set(round2Candidates.flatMap(({ batch }) => batch.map((c) => c.link).filter(Boolean)))];
    if (allUrlsRound2.length > 0) {
      const results = await checkUrlsConcurrent(allUrlsRound2, linkCheckOptions);
      for (const result of results) {
        linkAssessments.push({ url: result.url, linkStatus: result.linkStatus, issueType: result.issueType, detail: result.detail, timeMs: result.timeMs, round: 2 });
        validityCache.set(result.url, result.linkStatus !== LinkStatus.INVALID);
        if (result.linkStatus === LinkStatus.INVALID) {
          const termRanks = round2UrlToTermRanks.get(result.url) ?? [];
          for (const { searchTerm, rank } of termRanks) {
            deadLinks.push({ url: result.url, reason: result.detail || result.issueType, searchTerm, rank });
          }
        }
      }
    }

    for (const { searchTerm, batch } of round2Candidates) {
      const round1Batch = round1Candidates.find((r) => r.searchTerm === searchTerm)?.batch ?? [];
      let rankOffset = round1Batch.length;
      for (const citation of batch) {
        if (!citation.link) continue;
        rankOffset++;
        const isValid = validityCache.get(citation.link);
        if (isValid === true) addCitation(citation, searchTerm, rankOffset);
      }
    }
  }

  const extractedCount = Object.values(byTerm).reduce((sum, items) => sum + items.length, 0);

  const linkStats = checkLinks
    ? { retries: retriesUsed, deadLinks, deadLinksCount: deadLinks.length }
    : { retries: 0, deadLinks: [], deadLinksCount: 0 };

  // Write link_stats when slug provided and we have assessments
  if (slug && linkAssessments.length > 0) {
    const totalTimeMs = linkAssessments.reduce((sum, a) => sum + (a.timeMs ?? 0), 0);
    const times = linkAssessments.map((a) => a.timeMs ?? 0).filter((t) => t > 0);
    const validTimes = linkAssessments
      .filter((a) => a.linkStatus === 'probably_valid')
      .map((a) => a.timeMs ?? 0)
      .filter((t) => t > 0);
    const linkStatsPath = path.join(__dirname, 'link_stats', `${slug}.json`);
    fs.mkdirSync(path.dirname(linkStatsPath), { recursive: true });
    const maxTimeMs = times.length ? Math.max(...times) : 0;
    const maxValidTimeMs = validTimes.length ? Math.max(...validTimes) : 0;
    fs.writeFileSync(
      linkStatsPath,
      JSON.stringify(
        {
          slug,
          totalTimeMs,
          averageTimeMs: times.length ? totalTimeMs / times.length : 0,
          medianTimeMs: median(times),
          maxTimeMs,
          maxValidTimeMs,
          linkCount: linkAssessments.length,
          results: linkAssessments,
        },
        null,
        2
      ),
      'utf8'
    );
  }

  return {
    extracted: byTerm,
    stats: { extractedCount, linkStats },
  };
}
