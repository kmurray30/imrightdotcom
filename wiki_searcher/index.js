import { fetchWiki as fetchWikiViaMediaWiki } from './providers/mediawiki.js';
import { fetchWiki as fetchWikiViaSpans } from './providers/spans.js';

const PROVIDERS = {
  mediawiki: fetchWikiViaMediaWiki,
  spans: fetchWikiViaSpans,
};

/**
 * Wiki searcher: resolves conspirator search queries to Wikipedia articles.
 * Backend is chosen by the WIKI_SEARCH_PROVIDER env var:
 *   - 'mediawiki' (default): free MediaWiki Action API search, rate-limited.
 *   - 'spans': semantic search over Wikipedia's cited spans (providers/spans.js);
 *     returns the matched spans instead of pages.
 * All return the same shape, so callers (wiki_filterer, ref_extractor,
 * imright/index.js) never need to know which one ran.
 *
 * @param {object} conspiracyData
 * @param {object} [options]
 * @param {'mediawiki'|'spans'} [options.provider] - Overrides WIKI_SEARCH_PROVIDER.
 */
export async function fetchWiki(conspiracyData, options = {}) {
  const provider = options.provider ?? process.env.WIKI_SEARCH_PROVIDER ?? 'mediawiki';
  const fetchWikiImpl = PROVIDERS[provider];

  if (!fetchWikiImpl) {
    throw new Error(`Unknown WIKI_SEARCH_PROVIDER: "${provider}" (expected one of: ${Object.keys(PROVIDERS).join(', ')})`);
  }

  return fetchWikiImpl(conspiracyData, options);
}
