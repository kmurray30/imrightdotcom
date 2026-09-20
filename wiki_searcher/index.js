import { fetchWiki as fetchWikiViaMediaWiki } from './providers/mediawiki.js';
import { fetchWiki as fetchWikiViaWikimedia } from './providers/wikimedia.js';

const PROVIDERS = {
  mediawiki: fetchWikiViaMediaWiki,
  wikimedia: fetchWikiViaWikimedia,
};

/**
 * Wiki searcher: resolves conspirator search queries to Wikipedia articles.
 * Backend is chosen by the WIKI_SEARCH_PROVIDER env var:
 *   - 'mediawiki' (default): free MediaWiki Action API search, rate-limited.
 *   - 'wikimedia': local vector search + Wikimedia Enterprise On-demand fetch.
 * Both providers return the identical shape, so callers (wiki_filterer,
 * ref_extractor, imright/index.js) never need to know which one ran.
 *
 * @param {object} conspiracyData
 * @param {object} [options]
 * @param {'mediawiki'|'wikimedia'} [options.provider] - Overrides WIKI_SEARCH_PROVIDER.
 */
export async function fetchWiki(conspiracyData, options = {}) {
  const provider = options.provider ?? process.env.WIKI_SEARCH_PROVIDER ?? 'mediawiki';
  const fetchWikiImpl = PROVIDERS[provider];

  if (!fetchWikiImpl) {
    throw new Error(`Unknown WIKI_SEARCH_PROVIDER: "${provider}" (expected one of: ${Object.keys(PROVIDERS).join(', ')})`);
  }

  return fetchWikiImpl(conspiracyData, options);
}
