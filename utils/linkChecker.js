/**
 * HEAD-only link checker. Validates HTTP status, redirects, redirect-to-home.
 * No GET/body fetch—lightweight ping only.
 *
 * @module utils/linkChecker
 */

import { URL } from 'url';
import { isLinkWhitelisted } from './linkWhitelist.js';

/** @readonly */
export const LinkStatus = Object.freeze({
  INVALID: 'invalid',
  PROBABLY_VALID: 'probably_valid',
  FORBIDDEN: 'forbidden',
  WHITELISTED: 'whitelisted',
});

export { isLinkWhitelisted } from './linkWhitelist.js';

/** @readonly */
export const IssueType = Object.freeze({
  HTTP_404: 'http_404',
  HTTP_410: 'http_410',
  HTTP_401: 'http_401',
  HTTP_403: 'http_403',
  HTTP_405: 'http_405',
  HTTP_429: 'http_429',
  HTTP_4XX: 'http_4xx',
  HTTP_5XX: 'http_5xx',
  REDIRECT: 'redirect',
  REDIRECT_TO_HOME: 'redirect_to_home',
  CONNECTION_TIMEOUT: 'connection_timeout',
  DNS_FAILED: 'dns_failed',
  CONNECTION_REFUSED: 'connection_refused',
  SSL_ERROR: 'ssl_error',
  CONNECTION_FAILED: 'connection_failed',
});

const USER_AGENT = 'imright-link-checker/1.0';
const DEFAULT_TIMEOUT_MS = 18_000;

function normalizeUrlForComparison(urlString) {
  const parsed = new URL(urlString);
  const path = (parsed.pathname || '/').replace(/\/$/, '') || '/';
  return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${path}${parsed.search || ''}`;
}

function urlsDiffer(original, final) {
  return normalizeUrlForComparison(original) !== normalizeUrlForComparison(final);
}

function isHomePath(path) {
  const normalized = (path || '/').replace(/\/$/, '') || '/';
  return ['/', '/index', '/index.html', '/index.htm'].includes(normalized);
}

function stripWww(host) {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

function sameSite(originalHost, finalHost) {
  const orig = stripWww(originalHost);
  const final = stripWww(finalHost);
  if (orig === final) return true;
  return orig.endsWith('.' + final) || final.endsWith('.' + orig);
}

function isRedirectToHome(originalUrl, finalUrl) {
  const orig = new URL(originalUrl);
  const final = new URL(finalUrl);
  return sameSite(orig.hostname, final.hostname) && isHomePath(final.pathname);
}

function issueTypeFromError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  if (message.includes('timeout') || message.includes('timed out')) return IssueType.CONNECTION_TIMEOUT;
  if (message.includes('name resolution') || message.includes('nodename') || message.includes('getaddrinfo')) return IssueType.DNS_FAILED;
  if (message.includes('connection refused')) return IssueType.CONNECTION_REFUSED;
  if (message.includes('ssl') || message.includes('certificate')) return IssueType.SSL_ERROR;
  if (message.includes('connection')) return IssueType.CONNECTION_FAILED;
  return IssueType.CONNECTION_FAILED;
}

function humanUnreachableReason(error) {
  return issueTypeFromError(error).replace(/_/g, ' ');
}

/**
 * Check a single URL (HEAD only). Returns { linkStatus, issueType, detail }.
 *
 * @param {string} url - URL to check
 * @param {object} [options] - Optional { timeoutMs }
 * @returns {Promise<{ linkStatus: string, issueType: string | null, detail: string }>}
 */
export async function checkUrl(url, options = {}) {
  if (isLinkWhitelisted(url)) {
    return { linkStatus: LinkStatus.WHITELISTED, issueType: null, detail: '' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeoutId);

    const statusCode = response.status;
    const statusText = response.statusText || '';
    const detail = `HTTP ${statusCode} ${statusText}`.trim();

    if (statusCode < 200 || statusCode >= 300) {
      if (statusCode === 404) return { linkStatus: LinkStatus.INVALID, issueType: IssueType.HTTP_404, detail };
      if (statusCode === 410) return { linkStatus: LinkStatus.INVALID, issueType: IssueType.HTTP_410, detail };
      if (statusCode === 401) return { linkStatus: LinkStatus.FORBIDDEN, issueType: IssueType.HTTP_401, detail };
      if (statusCode === 403) return { linkStatus: LinkStatus.FORBIDDEN, issueType: IssueType.HTTP_403, detail };
      // 405, 429, connection timeout, and other non-401/403 unknowns → INVALID
      if (statusCode === 405) return { linkStatus: LinkStatus.INVALID, issueType: IssueType.HTTP_405, detail };
      if (statusCode === 429) return { linkStatus: LinkStatus.INVALID, issueType: IssueType.HTTP_429, detail };
      if (statusCode >= 400 && statusCode < 500) return { linkStatus: LinkStatus.INVALID, issueType: IssueType.HTTP_4XX, detail };
      return { linkStatus: LinkStatus.INVALID, issueType: IssueType.HTTP_5XX, detail };
    }

    const finalUrl = response.url;
    if (urlsDiffer(url, finalUrl)) {
      if (isRedirectToHome(url, finalUrl)) {
        return {
          linkStatus: LinkStatus.INVALID,
          issueType: IssueType.REDIRECT_TO_HOME,
          detail: `redirects to site home (page likely gone): ${finalUrl}`,
        };
      }
      return {
        linkStatus: LinkStatus.PROBABLY_VALID,
        issueType: IssueType.REDIRECT,
        detail: `redirects to different URL: ${finalUrl}`,
      };
    }

    return { linkStatus: LinkStatus.PROBABLY_VALID, issueType: null, detail: '' };
  } catch (error) {
    clearTimeout(timeoutId);
    const issueType = error.name === 'AbortError' ? IssueType.CONNECTION_TIMEOUT : issueTypeFromError(error);
    const detail = error.name === 'AbortError' ? 'connection timeout' : humanUnreachableReason(error);
    // Connection timeout, connection failed, DNS failed, etc. → INVALID. Only 401/403 stay FORBIDDEN (handled above).
    const linkStatus =
      issueType === IssueType.CONNECTION_TIMEOUT ||
      issueType === IssueType.CONNECTION_FAILED ||
      issueType === IssueType.DNS_FAILED ||
      issueType === IssueType.CONNECTION_REFUSED ||
      issueType === IssueType.SSL_ERROR
        ? LinkStatus.INVALID
        : LinkStatus.FORBIDDEN;
    return { linkStatus, issueType, detail };
  }
}

/**
 * Check multiple URLs with optional delay between requests.
 *
 * @param {string[]} urls - URLs to check
 * @param {object} [options] - Optional { timeoutMs, delayMs }
 * @returns {Promise<Array<{ url: string, linkStatus: string, issueType: string | null, detail: string }>>}
 */
export async function checkUrls(urls, options = {}) {
  const delayMs = options.delayMs ?? 500;
  const results = [];

  for (let index = 0; index < urls.length; index++) {
    if (index > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const result = await checkUrl(urls[index], options);
    results.push({ url: urls[index], ...result });
  }

  return results;
}
