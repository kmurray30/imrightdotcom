/**
 * Wikimedia Enterprise auth: exchanges a stored refresh token (or, as a
 * one-time fallback, a username/password) for a short-lived access token,
 * and keeps it cached in-memory across calls within this process.
 *
 * Token lifecycle (https://enterprise.wikimedia.com/docs/authentication/):
 *   - access_token/id_token expire in 24h.
 *   - refresh_token lasts 90 days and is good for up to 90 refresh calls.
 *   - Login is meant to happen rarely (~once per 90 days); day-to-day, refresh.
 *
 * Set WIKIMEDIA_REFRESH_TOKEN once (via wiki_searcher/scripts/wikimedia-login.js)
 * so the running app never needs your password. WIKIMEDIA_USERNAME/PASSWORD
 * are only used as a fallback if no refresh token is configured, or if the
 * stored one has expired/been exhausted.
 *
 * Note: the /v1/token-refresh request body below follows the same
 * {username, refresh_token} shape as /v1/login's worked example in the docs;
 * the docs describe the endpoint but don't show a literal curl example for
 * it, so double-check against the OpenAPI reference if this errors.
 */
import { callExternalApi, HttpStatusError, timeoutSignal } from './external-api.js';

const AUTH_BASE = 'https://auth.enterprise.wikimedia.com';
const TIMEOUT_MS = 10_000;
// Refresh a bit before the 24h expiry so we never race a request against it.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cachedAccessToken = null;
let cachedExpiresAt = 0; // epoch ms
let cachedRefreshToken = null;
let refreshTokenInitialized = false;

async function postJson(path, body) {
  return callExternalApi({
    service: 'wikimedia_enterprise',
    operation: 'auth',
    pipelineStep: 'wiki_search',
    fn: async () => {
      const response = await fetch(`${AUTH_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutSignal(TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new HttpStatusError(response.status, `Wikimedia Enterprise auth error: ${response.status} ${text}`.slice(0, 300));
      }
      return response.json();
    },
  });
}

function getConfiguredRefreshToken() {
  // Lazy read so this module doesn't care whether env vars were loaded
  // (load-env.js) before or after it was imported.
  if (!refreshTokenInitialized) {
    cachedRefreshToken = process.env.WIKIMEDIA_REFRESH_TOKEN || null;
    refreshTokenInitialized = true;
  }
  return cachedRefreshToken;
}

async function loginWithPassword() {
  const username = process.env.WIKIMEDIA_USERNAME;
  const password = process.env.WIKIMEDIA_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'Wikimedia Enterprise: no usable refresh token and WIKIMEDIA_USERNAME/WIKIMEDIA_PASSWORD are not set. ' +
      'Run wiki_searcher/scripts/wikimedia-login.js once to mint a refresh token, then set it as WIKIMEDIA_REFRESH_TOKEN.'
    );
  }
  const data = await postJson('/v1/login', { username: username.toLowerCase(), password });
  cachedRefreshToken = data.refresh_token;
  return data;
}

async function refreshWithToken() {
  const username = process.env.WIKIMEDIA_USERNAME;
  return postJson('/v1/token-refresh', {
    username: username ? username.toLowerCase() : undefined,
    refresh_token: cachedRefreshToken,
  });
}

/** Returns a currently-valid access token, refreshing or logging in as needed. */
export async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedExpiresAt - REFRESH_MARGIN_MS) {
    return cachedAccessToken;
  }

  const refreshToken = getConfiguredRefreshToken();
  let data;
  if (refreshToken) {
    try {
      data = await refreshWithToken();
    } catch {
      // Refresh token expired/exhausted (90 days or 90 uses) or was revoked.
      data = await loginWithPassword();
    }
  } else {
    data = await loginWithPassword();
  }

  cachedAccessToken = data.access_token;
  cachedExpiresAt = now + (data.expires_in ?? 86400) * 1000;
  return cachedAccessToken;
}
