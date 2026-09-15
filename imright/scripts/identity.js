/**
 * Anonymous visitor/session identity, traffic classification (bot/scanner vs.
 * real product traffic), and the dynamic verbose-trace sampling controller.
 *
 * None of this touches a database — visitor/session identity lives in
 * cookies, and the abuse/rate/volume counters are small in-memory maps
 * (approximate under multiple server replicas, exact for the single-instance
 * deployment this runs as today; see README).
 */

import crypto from 'crypto';
import { loadThresholds } from './observability.js';
import { setVerbose } from './interaction-context.js';

const VISITOR_COOKIE_NAME = 'imright_vid';
const SESSION_COOKIE_NAME = 'imright_sid';
const VISITOR_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // 400 days: the practical browser cap
const SESSION_IDLE_MAX_AGE_MS = 30 * 60 * 1000; // sliding 30-minute idle expiry
const HOUR_MS = 60 * 60 * 1000;

function buildCookie(name, value, maxAgeMs, secure) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Appends a cookie to any Set-Cookie header(s) already queued on the response, instead
 * of clobbering them — response.setHeader('Set-Cookie', x) replaces, it doesn't add. */
export function appendSetCookie(response, cookieString) {
  const existing = response.getHeader('Set-Cookie');
  const merged = existing ? [].concat(existing, cookieString) : [cookieString];
  response.setHeader('Set-Cookie', merged);
}

/**
 * Resolves (and if needed, issues) the visitor_id/session_id cookies for a request.
 * Call once per request, before writing any other response headers.
 * @returns {{ visitorId: string, sessionId: string, isNewVisitor: boolean, isNewSession: boolean }}
 */
export function resolveIdentity(request, response, cookies, { secure }) {
  let visitorId = cookies[VISITOR_COOKIE_NAME];
  const isNewVisitor = !visitorId;
  if (isNewVisitor) {
    visitorId = crypto.randomUUID();
    appendSetCookie(response, buildCookie(VISITOR_COOKIE_NAME, visitorId, VISITOR_MAX_AGE_MS, secure));
  }

  let sessionId = cookies[SESSION_COOKIE_NAME];
  const isNewSession = !sessionId;
  if (isNewSession) {
    sessionId = crypto.randomUUID();
  }
  // Sliding expiry: re-issue the cookie on every request so an active session doesn't
  // time out mid-use, without needing any server-side session store.
  appendSetCookie(response, buildCookie(SESSION_COOKIE_NAME, sessionId, SESSION_IDLE_MAX_AGE_MS, secure));

  return { visitorId, sessionId, isNewVisitor, isNewSession };
}

// --- Traffic classification ---

const SCANNER_PATH_PATTERNS = [
  /^\/wp-/i,
  /wp-login/i,
  /wp-content/i,
  /\.php$/i,
  /^\/xmlrpc\.php/i,
  /^\/\.env/i,
  /^\/\.git/i,
  /^\/\.aws/i,
  /^\/phpmyadmin/i,
  /^\/pma/i,
  /^\/admin/i,
  /^\/actuator/i,
  /^\/vendor\//i,
  /^\/cgi-bin/i,
  /^\/console/i,
  /^\/telescope/i,
  /^\/_profiler/i,
  /^\/debug\//i,
  /^\/\.well-known\/(?!acme-challenge)/i,
  /^\/config\.json$/i,
  /^\/server-status/i,
];

const KNOWN_CRAWLER_UA_PATTERN =
  /Googlebot|Mediapartners-Google|Google-Display-Ads-Bot|AdsBot-Google|APIs-Google|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot|facebookexternalhit|Twitterbot|LinkedInBot|Applebot|Slackbot|Discordbot|SemrushBot|AhrefsBot|MJ12bot|PetalBot/i;

/**
 * Classifies one request into a low-cardinality traffic_class for metrics.
 * Never the sole basis for authorization — UA is spoofable, this is for counting only.
 */
// The site does have a real /admin and /api/admin/* now (password-lock toggle),
// so those exact paths are carved out of the /^\/admin/i scanner heuristic below
// — everything else that merely starts with "/admin" (probes for other apps'
// admin panels) still counts as scanner_probe.
const REAL_ADMIN_PATH_PATTERN = /^\/(admin|api\/admin(\/|$))/i;

export function classifyTraffic({ method, urlPath, userAgent, hasVisitorCookie }) {
  if (!REAL_ADMIN_PATH_PATTERN.test(urlPath) && SCANNER_PATH_PATTERNS.some((pattern) => pattern.test(urlPath))) {
    return 'scanner_probe';
  }
  if (KNOWN_CRAWLER_UA_PATTERN.test(userAgent || '')) return 'known_crawler';
  if (method === 'POST' && urlPath === '/api/run') {
    // A real browser always has a visitor cookie by the time it can POST /api/run
    // (the landing page load that precedes it sets one). A direct API call with no
    // cookie at all skipped that step entirely.
    return hasVisitorCookie ? 'api_run' : 'suspicious_api';
  }
  return 'page';
}

// --- /api/run abuse heuristics: per-visitor/IP rate + duplicate-claim detection ---
// Approximate, in-memory, per-process by design — see module docstring.

const runsByVisitor = new Map(); // visitorId -> timestamps[]
const runsByIp = new Map(); // ip -> timestamps[]
const recentClaimsByVisitor = new Map(); // visitorId -> Map(claimHash -> timestamp)

function pruneOld(timestamps, windowMs, now) {
  while (timestamps.length > 0 && now - timestamps[0] > windowMs) timestamps.shift();
}

/**
 * Records one /api/run attempt and returns whether it looks abusive/duplicate.
 * Thresholds are configurable in config/telemetry_thresholds.json.
 */
export function checkRunAbuse({ visitorId, ip, claim }) {
  const { abuseHeuristics = {} } = loadThresholds();
  const now = Date.now();

  const visitorTimestamps = runsByVisitor.get(visitorId) ?? [];
  pruneOld(visitorTimestamps, HOUR_MS, now);
  visitorTimestamps.push(now);
  runsByVisitor.set(visitorId, visitorTimestamps);

  const ipTimestamps = runsByIp.get(ip) ?? [];
  pruneOld(ipTimestamps, HOUR_MS, now);
  ipTimestamps.push(now);
  runsByIp.set(ip, ipTimestamps);

  const suspectedAbuse =
    visitorTimestamps.length > (abuseHeuristics.maxRunsPerVisitorPerHour ?? Infinity) ||
    ipTimestamps.length > (abuseHeuristics.maxRunsPerIpPerHour ?? Infinity);

  const claimHash = crypto.createHash('sha256').update(claim.trim().toLowerCase()).digest('hex');
  const dupWindowMs = (abuseHeuristics.duplicateClaimWindowSeconds ?? 300) * 1000;
  const visitorClaims = recentClaimsByVisitor.get(visitorId) ?? new Map();
  const lastSeenAt = visitorClaims.get(claimHash);
  const duplicateRequest = lastSeenAt != null && now - lastSeenAt < dupWindowMs;
  visitorClaims.set(claimHash, now);
  recentClaimsByVisitor.set(visitorId, visitorClaims);

  return { suspectedAbuse, duplicateRequest };
}

/** Periodic cleanup so long-lived processes don't accumulate unbounded visitor/IP entries. */
function cleanupAbuseState() {
  const now = Date.now();
  for (const [key, timestamps] of runsByVisitor) {
    pruneOld(timestamps, HOUR_MS, now);
    if (timestamps.length === 0) runsByVisitor.delete(key);
  }
  for (const [key, timestamps] of runsByIp) {
    pruneOld(timestamps, HOUR_MS, now);
    if (timestamps.length === 0) runsByIp.delete(key);
  }
  const dupWindowMs = (loadThresholds().abuseHeuristics?.duplicateClaimWindowSeconds ?? 300) * 1000;
  for (const [visitorId, claims] of recentClaimsByVisitor) {
    for (const [claimHash, seenAt] of claims) {
      if (now - seenAt > dupWindowMs) claims.delete(claimHash);
    }
    if (claims.size === 0) recentClaimsByVisitor.delete(visitorId);
  }
}
setInterval(cleanupAbuseState, 10 * 60 * 1000).unref();

// --- Dynamic verbose-trace sampling ---
// Probability of pre-selecting a *normal* interaction for a full detailed trace,
// tapered automatically by recent traffic volume so early-stage debugging can see
// (almost) everything without risking runaway log volume once real traffic shows up.
// Error/anomalous interactions are always traced regardless of this (see
// observability.recordInteractionComplete) — this only governs the "just curious"
// sample of otherwise-ordinary interactions.

const interactionTimestamps = [];

export function noteInteractionStarted() {
  interactionTimestamps.push(Date.now());
}

function currentInteractionsPerHour() {
  const now = Date.now();
  pruneOld(interactionTimestamps, HOUR_MS, now);
  return interactionTimestamps.length;
}

function resolveSampleRate() {
  const tiers = loadThresholds().verbosityTiers?.tiers ?? [];
  const ratePerHour = currentInteractionsPerHour();
  for (const tier of tiers) {
    if (tier.maxInteractionsPerHour == null || ratePerHour <= tier.maxInteractionsPerHour) {
      return tier.sampleRate;
    }
  }
  return 0.01;
}

/**
 * Decides whether to pre-select this interaction for a full detailed trace, and
 * marks it on the (already-active) interaction context if so. Manual overrides,
 * read fresh each call so no restart is needed to flip them:
 *   TRACE_ALL=1                 - trace every interaction (short debugging windows)
 *   TRACE_VISITOR_ID=<uuid>     - always trace this one visitor
 *   TRACE_SAMPLE_RATE=<0..1>    - override the tapered rate directly
 */
export function decideVerboseSampling({ visitorId }) {
  noteInteractionStarted();

  const forced = process.env.TRACE_ALL === '1' || (process.env.TRACE_VISITOR_ID && process.env.TRACE_VISITOR_ID === visitorId);
  const sampleRate = process.env.TRACE_SAMPLE_RATE != null ? Number(process.env.TRACE_SAMPLE_RATE) : resolveSampleRate();
  const sampled = forced || Math.random() < sampleRate;

  if (sampled) setVerbose();
  return sampled;
}
