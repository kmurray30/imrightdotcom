/**
 * Hard-whitelisted hostnames for link validation. Sites that block HEAD but keep archives—
 * treat as valid without doing a HEAD check.
 *
 * @module utils/linkWhitelist
 */

/** Hostnames (normalized, no www) to skip HEAD check. */
export const LINK_WHITELIST_HOSTS = new Set([
  'academic.oup.com',
  'axios.com',
  'barrons.com',
  'bloomberg.com',
  'economist.com',
  'fastcompany.com',
  'forbes.com',
  'ft.com',
  'marketwatch.com',
  'nytimes.com',
  'onlinelibrary.wiley.com',
  'politico.com',
  'qz.com',
  'reuters.com',
  'science.org',
  'sciencedirect.com',
  'smithsonianmag.com',
  'thehill.com',
  'wsj.com',
]);

function normalizeHost(host) {
  const lower = (host || '').toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/** Returns true if the URL's host is in the link whitelist. */
export function isLinkWhitelisted(urlString) {
  try {
    const host = new URL(urlString).hostname;
    return LINK_WHITELIST_HOSTS.has(normalizeHost(host));
  } catch {
    return false;
  }
}
