/**
 * Wikimedia Enterprise On-demand API: fetch one article's current content by
 * exact title. Free tier: 50,000 lookups/month, 10 requests/second — used
 * here as the content-fetch step once a title has been found via vector
 * search, never for search itself (On-demand has no search endpoint).
 * https://enterprise.wikimedia.com/docs/on-demand/
 */
import { getAccessToken } from './wikimediaAuth.js';
import { callExternalApi, HttpStatusError, timeoutSignal } from './external-api.js';

const API_BASE = 'https://api.enterprise.wikimedia.com';
const TIMEOUT_MS = 15_000;

/**
 * @param {string} title - Exact article title.
 * @param {object} [options]
 * @param {string} [options.project] - is_part_of.identifier filter, default 'enwiki'.
 * @returns {Promise<object|null>} Wikimedia Enterprise article model, or null if no exact match.
 */
export async function fetchArticleByTitle(title, options = {}) {
  const project = options.project ?? 'enwiki';
  const accessToken = await getAccessToken();
  const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));

  const results = await callExternalApi({
    service: 'wikimedia_enterprise',
    operation: 'on_demand_fetch',
    pipelineStep: 'wiki_search',
    fn: async () => {
      const response = await fetch(`${API_BASE}/v2/articles/${encodedTitle}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filters: [{ field: 'is_part_of.identifier', value: project }],
          limit: 1,
        }),
        signal: timeoutSignal(TIMEOUT_MS),
      });
      if (!response.ok) {
        const retryAfterHeader = response.headers.get('retry-after');
        throw new HttpStatusError(response.status, `Wikimedia Enterprise on-demand error: ${response.status}`, {
          retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : undefined,
        });
      }
      return response.json();
    },
  });

  return Array.isArray(results) && results.length > 0 ? results[0] : null;
}

/** Maps a Wikimedia Enterprise article model onto the same page shape providers/mediawiki.js produces. */
export function toWikiPage(article) {
  return {
    pageid: article.identifier,
    title: article.name,
    extract: (article.abstract ?? '').trim(),
    source: (article.article_body?.wikitext ?? '').trim(),
    revision_id: article.version?.identifier,
    last_modified: article.date_modified,
  };
}
