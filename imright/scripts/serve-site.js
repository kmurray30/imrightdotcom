#!/usr/bin/env node
/**
 * Landing-page server for imright — Express app.
 *
 * Serves the static site (index.html or, once built, the React SPA in
 * client/dist), the generated-article assets, and exposes the API routes
 * that drive runPipeline plus the social layer (accounts, articles,
 * likes/bookmarks/follows/comments, discover).
 *
 * This used to be a hand-rolled `http.createServer` with manual
 * method+urlPath matching; ported to Express because the route count grew
 * past what that style could carry cleanly (see the plan's "Express
 * migration" milestone). Every existing route's behavior is preserved
 * exactly — this is a framework swap, not a feature change, except where
 * explicitly noted (handleApiRun's Postgres integration).
 *
 * Usage: node imright/scripts/serve-site.js [port]
 * Default port: 3758 (kept distinct from the CLI's 3757 so the CLI's port-kill
 * in imright/cli.js does not terminate this server).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { runPipeline } from '../index.js';
import { loadEnv } from '../load-env.js';
import {
  safeCompare,
  safeCompareHash,
  hashPassword,
  isLockedOut,
  recordLoginFailure,
  recordLoginSuccess,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  buildSessionCookie,
  buildExpiredCookie,
  getClientIp,
} from './auth.js';
import { readSiteLock, writeSiteLock } from './site-lock.js';
import {
  listPlaceholderSuggestionTexts,
  listPlaceholderSuggestions,
  addPlaceholderSuggestion,
  updatePlaceholderSuggestion,
  deletePlaceholderSuggestion,
} from './placeholder-suggestions.js';
import {
  startObservability,
  shutdownObservability,
  recordPageView,
  recordSubmit,
  recordTimeToReady,
  recordTrafficRequest,
  recordVisitor,
  recordSessionStart,
  recordInteractionStarted,
  recordInteractionComplete,
} from './observability.js';
import { resolveIdentity, appendSetCookie, classifyTraffic, checkRunAbuse, decideVerboseSampling } from './identity.js';
import { runWithInteractionContext, setClaimText, getSummary, addTraceEvent } from './interaction-context.js';
import { computeCost } from '../../utils/grok.js';
import { getArticleImagesRoot } from '../../utils/image-cache.js';
import { resolveLinks } from './backup-links.js';
import { resolveUser, ensureOwner, sweepExpiredSessions } from './auth-accounts.js';
import { accountRouter } from './routes/account.js';
import { socialRouter } from './routes/social.js';
import { createArticle, mergeArticleData } from './articles.js';
import {
  createPipelineRun,
  markPipelineRunReady,
  markPipelineRunDone,
  markPipelineRunError,
  getPipelineRun,
  claimPipelineRunRetry,
  MAX_PIPELINE_RUN_RETRIES,
} from './pipeline-runs.js';
import { HttpError } from './http-error.js';
import { runMigrations } from './db/migrate.js';

loadEnv();
startObservability();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CLIENT_DIST = path.join(PROJECT_ROOT, 'client', 'dist');

// Whether the main site is password-gated at all, and the hash of that
// password, live in Postgres (see site-lock.js) so they can be changed from
// /admin without a restart or a redeploy.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.error(
    '[serve-site] ADMIN_PASSWORD is not set — /admin is disabled until it is set in env.local (or the deploy environment) and the server is restarted.'
  );
}
// Generated fresh per process: signs the login cookie so it can't be forged.
// Restarting the server invalidates existing sessions, which is fine for a
// simple password gate like this one. (Real account sessions, added by this
// feature, are opaque DB-backed tokens instead — see auth-accounts.js.)
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE_NAME = 'imright_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const ADMIN_SESSION_COOKIE_NAME = 'imright_admin_session';
const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * High-level mode the server runs in. See MODE_DEFAULTS below for what each
 * mode implies (bind host, port).
 *   local - 127.0.0.1 (default). Only reachable from this machine.
 *   lan   - 0.0.0.0. Reachable from any host on the local network.
 *   prod  - 0.0.0.0. Production defaults.
 */
const MODE_DEFAULTS = {
  local: { host: '127.0.0.1', port: 3758 },
  lan: { host: '0.0.0.0', port: 3758 },
  prod: { host: '0.0.0.0', port: 3758 },
};
const DEFAULT_SERVE_MODE = 'local';

const requestedServeMode = (process.env.SERVE_MODE || DEFAULT_SERVE_MODE).trim().toLowerCase();
const SERVE_MODE = Object.prototype.hasOwnProperty.call(MODE_DEFAULTS, requestedServeMode)
  ? requestedServeMode
  : DEFAULT_SERVE_MODE;
if (SERVE_MODE !== requestedServeMode) {
  console.error(
    `[serve-site] unknown SERVE_MODE "${requestedServeMode}"; valid: ${Object.keys(MODE_DEFAULTS).join(', ')}. Falling back to "${DEFAULT_SERVE_MODE}".`
  );
}
const modeConfig = MODE_DEFAULTS[SERVE_MODE];
const IS_SECURE = SERVE_MODE === 'prod';

// Postgres now backs both the site-lock state (as before) and the whole
// social layer (accounts/articles/etc.) — required in prod for the same
// reason as before (Railway's app filesystem doesn't survive redeploys),
// and now for a second reason too (articles/accounts have nowhere else to live).
if (!process.env.DATABASE_URL) {
  if (SERVE_MODE === 'prod') {
    console.error(
      '[serve-site] DATABASE_URL is not set. Refusing to start in prod without it — the site password lock and the entire social layer (accounts, articles, likes, etc.) live in Postgres so they survive redeploys. Add a Postgres database in Railway (New -> Database -> PostgreSQL; it injects DATABASE_URL automatically) and restart.'
    );
    process.exit(1);
  }
  console.error(
    '[serve-site] DATABASE_URL is not set — site-lock state and the entire social layer will not work. Fine for exercising just the idea-input pipeline locally; required for everything else.'
  );
}

// Precedence: explicit CLI arg (port) > env var > mode default.
const PORT = parseInt(process.argv[2] || process.env.PORT || String(modeConfig.port), 10);
const SERVE_HOST = (process.env.SERVE_HOST || modeConfig.host).trim();

const APP_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'app_config.json');
const COLOR_SCHEMES_PATH = path.join(PROJECT_ROOT, 'config', 'color_schemes.json');
const DEFAULT_COLOR_SCHEME_NAME = 'home_background_1';
const ACTIVE_HOME_BACKGROUND_PLACEHOLDER = 'ACTIVE_HOME_BACKGROUND_LAYERS';

/**
 * Hard-coded backstop for the home background. Used only if config files are
 * missing, malformed, or point at a scheme that no longer exists. Kept
 * identical to home_background_1 in config/color_schemes.json so the page
 * still looks correct in failure modes.
 */
const FALLBACK_HOME_BACKGROUND_LAYERS = [
  'radial-gradient(circle at 18% 12%, rgba(255, 196, 120, 0.65), transparent 55%)',
  'radial-gradient(circle at 82% 8%, rgba(255, 130, 140, 0.55), transparent 55%)',
  'radial-gradient(circle at 90% 90%, rgba(148, 182, 255, 0.55), transparent 55%)',
  'radial-gradient(circle at 10% 85%, rgba(178, 240, 200, 0.55), transparent 55%)',
  'linear-gradient(180deg, #fff4ea 0%, #f1ebff 55%, #eaf1ff 100%)',
];

/**
 * Read `config/app_config.json` and `config/color_schemes.json` and return the
 * CSS `background` value (layers joined with ', ') for the currently active
 * scheme. Any failure (missing file, invalid JSON, unknown scheme, missing
 * layers) logs a warning and falls back to the hard-coded default so the
 * landing page never breaks on a config typo.
 */
function resolveActiveHomeBackground() {
  let activeSchemeName = DEFAULT_COLOR_SCHEME_NAME;
  try {
    const appConfigRaw = fs.readFileSync(APP_CONFIG_PATH, 'utf8');
    const appConfig = JSON.parse(appConfigRaw);
    if (typeof appConfig.activeColorScheme === 'string' && appConfig.activeColorScheme.trim()) {
      activeSchemeName = appConfig.activeColorScheme.trim();
    }
  } catch (appConfigError) {
    console.error(
      `[serve-site] could not read ${APP_CONFIG_PATH}; using default scheme "${DEFAULT_COLOR_SCHEME_NAME}":`,
      appConfigError?.message ?? appConfigError
    );
  }

  let schemes;
  try {
    const colorSchemesRaw = fs.readFileSync(COLOR_SCHEMES_PATH, 'utf8');
    const parsed = JSON.parse(colorSchemesRaw);
    schemes = parsed && typeof parsed === 'object' ? parsed.schemes : null;
  } catch (colorSchemesError) {
    console.error(
      `[serve-site] could not read ${COLOR_SCHEMES_PATH}; using hard-coded fallback layers:`,
      colorSchemesError?.message ?? colorSchemesError
    );
    return FALLBACK_HOME_BACKGROUND_LAYERS.join(', ');
  }

  if (!schemes || typeof schemes !== 'object') {
    console.error(`[serve-site] ${COLOR_SCHEMES_PATH} has no "schemes" object; using hard-coded fallback layers.`);
    return FALLBACK_HOME_BACKGROUND_LAYERS.join(', ');
  }

  const activeScheme = schemes[activeSchemeName] ?? schemes[DEFAULT_COLOR_SCHEME_NAME];
  if (!activeScheme) {
    console.error(
      `[serve-site] active color scheme "${activeSchemeName}" not found and default "${DEFAULT_COLOR_SCHEME_NAME}" is missing too; using hard-coded fallback layers.`
    );
    return FALLBACK_HOME_BACKGROUND_LAYERS.join(', ');
  }

  if (!activeScheme.background || !Array.isArray(activeScheme.background) || activeScheme.background.length === 0) {
    console.error(
      `[serve-site] color scheme "${activeSchemeName}" is missing a non-empty "background" array; using hard-coded fallback layers.`
    );
    return FALLBACK_HOME_BACKGROUND_LAYERS.join(', ');
  }

  return activeScheme.background.join(', ');
}

/** Renders any of index.html/login.html/admin-login.html the same way: read,
 * substitute the background placeholder, send. */
function renderTemplatedPage(pagePath, response, { statusCode = 200, cacheControl = 'no-cache', extraSubstitutions = [] } = {}) {
  fs.readFile(pagePath, 'utf8', (readError, rawHtml) => {
    if (readError) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Failed to read ${path.basename(pagePath)}`);
      return;
    }
    let renderedHtml = rawHtml.split(ACTIVE_HOME_BACKGROUND_PLACEHOLDER).join(resolveActiveHomeBackground());
    for (const [placeholder, value] of extraSubstitutions) {
      renderedHtml = renderedHtml.split(placeholder).join(value);
    }
    response.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl });
    response.end(renderedHtml);
  });
}

function serveLandingPage(response) {
  renderTemplatedPage(path.join(PROJECT_ROOT, 'index.html'), response);
}

function serveLoginPage(response, statusCode = 200) {
  renderTemplatedPage(path.join(PROJECT_ROOT, 'imright', 'login.html'), response, { statusCode, cacheControl: 'no-store' });
}

function serveAdminLoginPage(response, statusCode = 200) {
  renderTemplatedPage(path.join(PROJECT_ROOT, 'imright', 'admin-login.html'), response, {
    statusCode,
    cacheControl: 'no-store',
  });
}

function isAuthenticated(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return false;
  return verifySessionToken(token, SESSION_SECRET);
}

function isAdminAuthenticated(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[ADMIN_SESSION_COOKIE_NAME];
  if (!token) return false;
  return verifySessionToken(token, ADMIN_SESSION_SECRET);
}

/**
 * Render admin.html with the current site-lock state (protection on/off,
 * whether a password is set — never the password or its hash) inlined as
 * JSON, so the dashboard shows correct state on first paint.
 */
async function serveAdminDashboardPage(response) {
  const siteLock = await readSiteLock();
  const adminStateJson = JSON.stringify({
    passwordProtectionEnabled: siteLock.passwordProtectionEnabled,
    passwordSet: Boolean(siteLock.passwordHash),
  });
  renderTemplatedPage(path.join(PROJECT_ROOT, 'imright', 'admin.html'), response, {
    cacheControl: 'no-store',
    extraSubstitutions: [['ADMIN_STATE_JSON', adminStateJson]],
  });
}

/**
 * Lets Google's crawlers (AdSense review + ad-serving bots) read the site
 * without a session, since the password gate would otherwise 401 them and
 * block AdSense verification/ad delivery entirely. User-Agent sniffing is
 * spoofable, so this only ever grants read access (GET/HEAD), never bypasses
 * auth for POST endpoints like /api/run.
 */
const GOOGLE_BOT_USER_AGENT_PATTERN = /Googlebot|Mediapartners-Google|Google-Display-Ads-Bot|AdsBot-Google|APIs-Google/i;

function isGoogleBotRequest(request) {
  const userAgent = request.headers['user-agent'] || '';
  return GOOGLE_BOT_USER_AGENT_PATTERN.test(userAgent);
}

// ---------------------------------------------------------------------------
// Site-wide password gate + admin dashboard — unrelated to the new account
// system (see auth-accounts.js) and deliberately left alone.
// ---------------------------------------------------------------------------

async function handleApiLogin(request, response) {
  const clientIp = getClientIp(request);
  const lockoutKey = `site:${clientIp}`;

  if (isLockedOut(lockoutKey)) {
    recordTrafficRequest('blocked');
    response.status(429).json({ error: 'too_many_attempts' });
    return;
  }

  const siteLock = await readSiteLock();
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (!password || !safeCompareHash(password, siteLock.passwordHash)) {
    recordLoginFailure(lockoutKey);
    response.status(401).json({ error: 'invalid_password' });
    return;
  }

  recordLoginSuccess(lockoutKey);
  const token = createSessionToken(SESSION_SECRET, SESSION_MAX_AGE_MS);
  appendSetCookie(response, buildSessionCookie(SESSION_COOKIE_NAME, token, SESSION_MAX_AGE_MS, IS_SECURE));
  response.json({ ok: true });
}

function handleApiLogout(response) {
  appendSetCookie(response, buildExpiredCookie(SESSION_COOKIE_NAME, IS_SECURE));
  response.json({ ok: true });
}

async function handleApiAdminLogin(request, response) {
  if (!ADMIN_PASSWORD) {
    response.status(503).json({ error: 'admin_disabled' });
    return;
  }

  const clientIp = getClientIp(request);
  const lockoutKey = `admin:${clientIp}`;

  if (isLockedOut(lockoutKey)) {
    recordTrafficRequest('blocked');
    response.status(429).json({ error: 'too_many_attempts' });
    return;
  }

  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (!password || !safeCompare(password, ADMIN_PASSWORD)) {
    recordLoginFailure(lockoutKey);
    response.status(401).json({ error: 'invalid_password' });
    return;
  }

  recordLoginSuccess(lockoutKey);
  const token = createSessionToken(ADMIN_SESSION_SECRET, ADMIN_SESSION_MAX_AGE_MS);
  appendSetCookie(response, buildSessionCookie(ADMIN_SESSION_COOKIE_NAME, token, ADMIN_SESSION_MAX_AGE_MS, IS_SECURE));
  response.json({ ok: true });
}

function handleApiAdminLogout(response) {
  appendSetCookie(response, buildExpiredCookie(ADMIN_SESSION_COOKIE_NAME, IS_SECURE));
  response.json({ ok: true });
}

async function handleApiAdminSettings(request, response) {
  if (!isAdminAuthenticated(request)) {
    response.status(401).json({ error: 'unauthenticated' });
    return;
  }

  const body = request.body ?? {};
  const patch = {};
  if (typeof body.passwordProtectionEnabled === 'boolean') {
    patch.passwordProtectionEnabled = body.passwordProtectionEnabled;
  }
  if (typeof body.newPassword === 'string') {
    if (!body.newPassword) {
      response.status(400).json({ error: 'empty_password' });
      return;
    }
    patch.passwordHash = hashPassword(body.newPassword);
  }

  const updated = await writeSiteLock(patch);
  response.json({
    passwordProtectionEnabled: updated.passwordProtectionEnabled,
    passwordSet: Boolean(updated.passwordHash),
  });
}

// ---------------------------------------------------------------------------
// Placeholder-ideas admin CRUD — the pool of example beliefs the landing
// page's animated placeholder cycles through (see placeholder-suggestions.js).
// The read used by the animation itself (no admin auth needed) is
// GET /api/placeholder-suggestions, registered alongside /api/run below.
// ---------------------------------------------------------------------------

async function handleApiAdminListPlaceholderSuggestions(request, response) {
  if (!isAdminAuthenticated(request)) {
    response.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const suggestions = await listPlaceholderSuggestions();
  response.json({ suggestions });
}

async function handleApiAdminAddPlaceholderSuggestion(request, response) {
  if (!isAdminAuthenticated(request)) {
    response.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
  if (!text) {
    response.status(400).json({ error: 'empty_text' });
    return;
  }
  const created = await addPlaceholderSuggestion(text);
  response.status(201).json({ suggestion: created });
}

async function handleApiAdminUpdatePlaceholderSuggestion(request, response) {
  if (!isAdminAuthenticated(request)) {
    response.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = Number.parseInt(request.params.id, 10);
  const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
  if (!Number.isInteger(id) || !text) {
    response.status(400).json({ error: 'invalid_request' });
    return;
  }
  const updated = await updatePlaceholderSuggestion(id, text);
  if (!updated) {
    response.status(404).json({ error: 'not_found' });
    return;
  }
  response.json({ suggestion: updated });
}

async function handleApiAdminDeletePlaceholderSuggestion(request, response) {
  if (!isAdminAuthenticated(request)) {
    response.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = Number.parseInt(request.params.id, 10);
  if (!Number.isInteger(id)) {
    response.status(400).json({ error: 'invalid_request' });
    return;
  }
  const deleted = await deletePlaceholderSuggestion(id);
  if (!deleted) {
    response.status(404).json({ error: 'not_found' });
    return;
  }
  response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// /api/run + SSE progress stream
// ---------------------------------------------------------------------------

/**
 * In-memory map of runId -> run state. Each run has a subscriber array (SSE
 * response streams) plus a buffered event history so a client that connects
 * a moment after POST /api/run still sees every stage event from the start.
 */
const activeRuns = new Map();

function createRunState() {
  return { events: [], finished: false, subscribers: new Set() };
}

function broadcastEvent(runState, event) {
  runState.events.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of runState.subscribers) {
    try {
      response.write(payload);
    } catch {
      // If a single subscriber errors, drop it; others proceed.
    }
  }
}

/**
 * Registers a run in activeRuns and kicks off runPipeline for it, wiring
 * progress/ready/done/error broadcasting, article persistence, and the
 * durable pipeline_runs row. Shared between a fresh POST /api/run and the
 * automatic-retry path in handleApiStream (claimPipelineRunRetry) — both
 * need identical wiring; the only difference is who decided to call this
 * and whether runId already had a pipeline_runs row (either way, this
 * function's UPDATEs just find it and don't care how it got there).
 */
function startPipelineRun({ runId, ownerUserId, claim, visitorId, sessionId, trafficClass, suspectedAbuse = false, duplicateRequest = false }) {
  const runState = createRunState();
  activeRuns.set(runId, runState);

  recordSubmit(claim);
  recordInteractionStarted();
  const submittedAt = performance.now();
  let pipelineResult = null;
  let articleRow = null;
  let articlePersistedPromise = Promise.resolve();

  const onProgress = (stepIndex, totalSteps, message) => {
    broadcastEvent(runState, { type: 'progress', step: stepIndex, total: totalSteps, name: message });
  };

  const onStepComplete = (stepIndex, totalSteps, message, delta) => {
    addTraceEvent('pipeline_step', { step: stepIndex, total: totalSteps, name: message, ...delta });
    broadcastEvent(runState, { type: 'stepComplete', step: stepIndex, total: totalSteps, name: message });
  };

  const onPageReady = (readySlug, articleData) => {
    recordTimeToReady(performance.now() - submittedAt, readySlug);
    // Insert right here, not after runPipeline's whole promise resolves —
    // that promise doesn't settle until AFTER step 7 (counterarguments), and
    // onPageReady exists specifically so the user doesn't wait for step 7.
    // Not awaited here (onPageReady is a synchronous callback into
    // runPipeline) — but the promise is kept, and awaited below in
    // .finally(), so the counterarguments merge can never race ahead of it.
    articlePersistedPromise = createArticle({ ownerUserId, claimText: claim, articleData })
      .then(async (row) => {
        articleRow = row;
        await markPipelineRunReady({ id: runId, articleId: row.id }).catch((error) =>
          console.error('[serve-site] failed to mark pipeline run ready:', error?.message ?? error)
        );
        broadcastEvent(runState, { type: 'ready', articleId: row.id, url: `/a/${row.id}` });
      })
      .catch(async (error) => {
        console.error('[serve-site] failed to persist article:', error?.message ?? error);
        await markPipelineRunError({ id: runId, errorMessage: 'Failed to save article' }).catch(() => {});
        broadcastEvent(runState, { type: 'error', message: 'Failed to save article' });
      });
  };

  function completeInteraction(success) {
    const summary = getSummary();
    const costUsd = computeCost(summary.tokenUsage).totalCost;
    recordInteractionComplete({
      interactionId: summary.interactionId,
      visitorId: summary.visitorId,
      sessionId: summary.sessionId,
      trafficClass: summary.trafficClass,
      success,
      durationMs: performance.now() - submittedAt,
      stageRows: pipelineResult?.stageRows ?? [],
      tokenUsage: summary.tokenUsage,
      costUsd,
      llm: summary.llm,
      external: summary.external,
      suspectedAbuse,
      duplicateRequest,
      claimLength: claim.length,
      verbose: summary.verbose,
      claimText: summary.claimText,
      events: summary.events,
    });
  }

  runWithInteractionContext({ interactionId: runId, visitorId, sessionId, trafficClass }, () => {
    setClaimText(claim);
    decideVerboseSampling({ visitorId });

    return runPipeline(claim, { onProgress, onStepComplete, onPageReady })
      .then(async (result) => {
        pipelineResult = result;
        completeInteraction(true);
        await markPipelineRunDone(runId).catch((error) =>
          console.error('[serve-site] failed to mark pipeline run done:', error?.message ?? error)
        );
        broadcastEvent(runState, { type: 'done' });
      })
      .catch(async (pipelineError) => {
        console.error('[serve-site] pipeline error:', pipelineError);
        completeInteraction(false);
        const message = pipelineError?.message ?? 'Pipeline failed';
        await markPipelineRunError({ id: runId, errorMessage: message }).catch((error) =>
          console.error('[serve-site] failed to mark pipeline run error:', error?.message ?? error)
        );
        broadcastEvent(runState, { type: 'error', message });
      })
      .finally(async () => {
        // Guarantees articleRow is settled (not just "probably settled by
        // now" — see articlePersistedPromise above) before deciding whether
        // there's a row to merge counterarguments into.
        await articlePersistedPromise;
        if (articleRow && pipelineResult?.counterarguments) {
          try {
            await mergeArticleData(articleRow.id, { counterarguments: pipelineResult.counterarguments });
            broadcastEvent(runState, { type: 'counterarguments', articleId: articleRow.id });
          } catch (mergeError) {
            console.error('[serve-site] failed to merge counterarguments:', mergeError?.message ?? mergeError);
          }
        }
        runState.finished = true;
        setTimeout(() => {
          for (const subscriberResponse of runState.subscribers) {
            try {
              subscriberResponse.end();
            } catch {
              // ignore
            }
          }
          runState.subscribers.clear();
          setTimeout(() => activeRuns.delete(runId), 60_000);
        }, 250);
      });
  });

  return runState;
}

/**
 * POST /api/run { claim }
 * Starts runPipeline in the background and returns { runId }. Progress, and
 * the onPageReady signal, are streamed via /api/stream/:runId.
 *
 * Behavior change from before this feature: the generated article's
 * permanent identity is now a Postgres `articles` row (owner + real UUID),
 * not a static HTML file keyed by slug — see the plan's "Deliberate behavior
 * change" note. ensureOwner() is the one place a guest identity gets
 * provisioned (see auth-accounts.js).
 */
async function handleApiRun(request, response) {
  const claim = typeof request.body?.claim === 'string' ? request.body.claim.trim() : '';
  if (!claim) {
    response.status(400).json({ error: 'missing_claim' });
    return;
  }

  const owner = await ensureOwner(request, response);
  const { visitorId, sessionId, trafficClassBase } = request.identity;
  const clientIp = getClientIp(request);
  const { suspectedAbuse, duplicateRequest } = checkRunAbuse({ visitorId, ip: clientIp, claim });
  // A visitor tripping the abuse heuristics gets reclassified even if their cookie made
  // them look like a normal browser session — visibility, not enforcement (see README).
  const trafficClass = suspectedAbuse ? 'suspicious_api' : trafficClassBase;

  const interactionId = crypto.randomUUID();
  try {
    // Durable record of this run, so a reconnect that lands on a different
    // process (this one restarted mid-run — a deploy, a crash) can be
    // recovered instead of stranded on a bare 404 the client retries
    // forever. See handleApiStream's DB fallback and schema.js's
    // pipelineRuns docstring — claimText is kept specifically so an
    // interrupted run can be auto-retried from scratch, not just reported.
    await createPipelineRun({ id: interactionId, ownerUserId: owner.id, claimText: claim });
  } catch (error) {
    console.error('[serve-site] failed to record pipeline run:', error?.message ?? error);
  }

  response.json({ runId: interactionId });

  startPipelineRun({
    runId: interactionId,
    ownerUserId: owner.id,
    claim,
    visitorId,
    sessionId,
    trafficClass,
    suspectedAbuse,
    duplicateRequest,
  });
}

/** Writes SSE headers, replays the given terminal event(s), and ends the
 * response — for the two DB-fallback cases that have nothing left to
 * stream live (already finished, or genuinely failed). */
function respondWithSynthesizedEvents(response, events) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  response.write(': connected\n\n');
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function handleApiStream(request, response) {
  const runId = request.params.runId;
  let runState = activeRuns.get(runId);

  if (!runState) {
    // Not in this process's memory — either runId never existed, or (the
    // case this exists for) it was running on a process that's since died
    // (a deploy, a crash) and this is a fresh one. Falls back to the
    // durable pipeline_runs row instead of a bare 404, which is what used
    // to send the client's EventSource into a silent, permanent retry loop.
    let run;
    try {
      run = await getPipelineRun(runId);
    } catch (error) {
      console.error('[serve-site] failed to look up persisted pipeline run:', error?.message ?? error);
    }
    if (!run) {
      response.status(404).type('text/plain').send('Unknown runId');
      return;
    }

    if (run.status === 'ready' || run.status === 'done') {
      respondWithSynthesizedEvents(response, [
        { type: 'ready', articleId: run.articleId, url: `/a/${run.articleId}` },
        { type: 'done' },
      ]);
      return;
    }

    if (run.status === 'error') {
      respondWithSynthesizedEvents(response, [{ type: 'error', message: run.errorMessage || 'Pipeline failed' }]);
      return;
    }

    // status === 'running' with nobody's activeRuns owning it: singleton
    // deploys mean there's never a second live process that could still
    // legitimately own it, so this can only mean it was interrupted.
    // Recover automatically rather than just reporting that: restart the
    // whole pipeline from scratch under the same runId. claimPipelineRunRetry
    // is one atomic UPDATE, so if several reconnects land at once (multiple
    // tabs, the browser's own EventSource retry racing a manual refresh),
    // only one of them actually restarts it.
    const claimed = await claimPipelineRunRetry(runId).catch((error) => {
      console.error('[serve-site] failed to claim pipeline run retry:', error?.message ?? error);
      return null;
    });

    if (claimed) {
      console.error(`[serve-site] auto-retrying interrupted run ${runId} (attempt ${claimed.retryCount + 1})`);
      runState = startPipelineRun({
        runId,
        ownerUserId: claimed.ownerUserId,
        claim: claimed.claimText,
        visitorId: request.identity.visitorId,
        sessionId: request.identity.sessionId,
        trafficClass: request.identity.trafficClassBase,
      });
      // Falls through to the live-streaming path below with the freshly
      // started runState, exactly as if it had been found in activeRuns.
    } else {
      // Retries exhausted (or another concurrent reconnect just claimed
      // this attempt — vanishingly small window; worst case this request
      // reports an error while that one silently succeeds for whichever
      // tab stays connected).
      const message =
        run.retryCount >= MAX_PIPELINE_RUN_RETRIES
          ? 'This article could not be generated after several attempts. Please try again later.'
          : 'This run was interrupted. Please try again.';
      respondWithSynthesizedEvents(response, [{ type: 'error', message }]);
      return;
    }
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  response.write(': connected\n\n');

  for (const bufferedEvent of runState.events) {
    response.write(`data: ${JSON.stringify(bufferedEvent)}\n\n`);
  }

  if (runState.finished) {
    response.end();
    return;
  }

  runState.subscribers.add(response);
  request.on('close', () => {
    runState.subscribers.delete(response);
  });
}

/**
 * POST /api/link-status { urls: string[] }
 * Best-effort citation-link healing — see backup-links.js. Any failure
 * returns an empty object, leaving the page's links exactly as rendered.
 */
async function handleApiLinkStatus(request, response) {
  const urls = Array.isArray(request.body?.urls) ? request.body.urls.filter((u) => typeof u === 'string') : [];
  if (urls.length === 0) {
    response.json({});
    return;
  }
  const resolved = await resolveLinks(urls);
  response.json(Object.fromEntries(resolved));
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Identity + traffic classification happen for every request, before
// auth/routing, so scanner noise and unauthenticated probes are counted too.
app.use(async (request, response, next) => {
  const urlPath = request.path;
  const cookies = parseCookies(request.headers.cookie);
  const { visitorId, sessionId, isNewVisitor, isNewSession } = resolveIdentity(request, response, cookies, {
    secure: IS_SECURE,
  });
  recordVisitor(isNewVisitor);
  if (isNewSession) recordSessionStart();
  const trafficClassBase = classifyTraffic({
    method: request.method,
    urlPath,
    userAgent: request.headers['user-agent'],
    hasVisitorCookie: !isNewVisitor,
  });
  recordTrafficRequest(trafficClassBase);
  request.identity = { visitorId, sessionId, trafficClassBase };

  // Real-account / guest identity (see auth-accounts.js) — read-only here,
  // never provisions a row (see that module's docstring for why).
  await resolveUser(request, response);
  next();
});

// Login/logout must be reachable without a session; everything else below is gated.
app.post('/api/login', (req, res, next) => handleApiLogin(req, res).catch(next));
app.post('/api/logout', (req, res) => handleApiLogout(res));
app.post('/api/admin/login', (req, res, next) => handleApiAdminLogin(req, res).catch(next));
app.post('/api/admin/logout', (req, res) => handleApiAdminLogout(res));
app.post('/api/admin/settings', (req, res, next) => handleApiAdminSettings(req, res).catch(next));
app.get('/api/admin/placeholder-suggestions', (req, res, next) =>
  handleApiAdminListPlaceholderSuggestions(req, res).catch(next)
);
app.post('/api/admin/placeholder-suggestions', (req, res, next) =>
  handleApiAdminAddPlaceholderSuggestion(req, res).catch(next)
);
app.patch('/api/admin/placeholder-suggestions/:id', (req, res, next) =>
  handleApiAdminUpdatePlaceholderSuggestion(req, res).catch(next)
);
app.delete('/api/admin/placeholder-suggestions/:id', (req, res, next) =>
  handleApiAdminDeletePlaceholderSuggestion(req, res).catch(next)
);

app.get('/admin', async (request, response, next) => {
  try {
    if (!ADMIN_PASSWORD) {
      response.status(503).type('text/plain').send('Admin panel disabled: ADMIN_PASSWORD is not configured.');
      return;
    }
    if (isAdminAuthenticated(request)) {
      await serveAdminDashboardPage(response);
    } else {
      serveAdminLoginPage(response);
    }
  } catch (error) {
    next(error);
  }
});

// Site-wide password gate — everything past this point requires a session
// when protection is enabled, except a couple of narrow, read-only carve-outs.
app.use(async (request, response, next) => {
  try {
    const siteLock = await readSiteLock();
    if (!siteLock.passwordProtectionEnabled || isAuthenticated(request)) {
      next();
      return;
    }
    const isBotReadRequest =
      (request.method === 'GET' || request.method === 'HEAD') &&
      (request.path === '/ads.txt' || isGoogleBotRequest(request));
    if (isBotReadRequest) {
      next();
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      serveLoginPage(response);
    } else {
      response.status(401).json({ error: 'unauthenticated' });
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/run', (req, res, next) => handleApiRun(req, res).catch(next));
app.get('/api/stream/:runId', (req, res, next) => handleApiStream(req, res).catch(next));
app.post('/api/link-status', (req, res, next) => handleApiLinkStatus(req, res).catch(next));
// Read-only list of example beliefs for the belief input's animated
// placeholder (both index.html and the React BeliefForm) — no admin auth
// needed, same as the config file this replaced; still behind the
// site-wide password gate above, like every other route down here.
app.get('/api/placeholder-suggestions', async (req, res, next) => {
  try {
    const suggestions = await listPlaceholderSuggestionTexts();
    res.json({ suggestions });
  } catch (error) {
    next(error);
  }
});

app.use('/api/account', accountRouter);
app.use('/api', socialRouter);

// Stable URL namespace for an article's permanent images, decoupled from
// where getArticleImagesRoot() actually points (a project-relative dev path,
// or a sibling of the mounted volume in prod) — see the plan's image
// durability fix. article_data.slug + the filenames in article_data.images
// are what the frontend combines into these URLs.
app.use(
  '/article-images',
  express.static(getArticleImagesRoot(), {
    cacheControl: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  // React SPA build exists: serve it (and its assets) for '/', falling back
  // to it for any unmatched GET so React Router's client-side routes work on
  // a direct load/refresh. Legacy static assets (config/, tabloid_generator
  // images, etc.) are still served by the PROJECT_ROOT static mount below.
  app.use(express.static(CLIENT_DIST, { cacheControl: false }));
} else {
  app.get(['/', '/index.html'], (req, res) => {
    recordPageView('landing');
    serveLandingPage(res);
  });
}

// Legacy static file serving (config/, tabloid_generator output/images,
// debug pages, etc.) — kept for anything not superseded by the API/SPA above.
app.use(
  express.static(PROJECT_ROOT, {
    cacheControl: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  app.get('/*splat', (req, res) => {
    if (req.method !== 'GET') {
      res.status(405).type('text/plain').send('Method Not Allowed');
      return;
    }
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

app.use((request, response) => {
  response.status(404).type('text/plain').send('Not Found');
});

// Central error handler: HttpError -> its status/code; a JSON parse error
// from express.json() -> 400 invalid_json (matching the old hand-rolled
// readJsonBody's behavior); anything else -> 500, logged.
app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.code });
    return;
  }
  if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large' || error instanceof SyntaxError) {
    // Matches the old hand-rolled readJsonBody's behavior: any malformed or
    // oversized body just comes back as 400 invalid_json, not a 413.
    response.status(400).json({ error: 'invalid_json' });
    return;
  }
  console.error('[serve-site] unhandled error:', error);
  response.status(500).json({ error: 'internal_error' });
});

await runMigrations();
await sweepExpiredSessions();

const server = app.listen(PORT, SERVE_HOST, () => {
  const url = `http://127.0.0.1:${PORT}`;
  process.stdout.write(`${url}\n`);
  const reachability = SERVE_HOST === '0.0.0.0' ? 'reachable on the local network' : 'local machine only';
  console.error(`[serve-site] mode=${SERVE_MODE} listening on ${SERVE_HOST}:${PORT} (${reachability}); open ${url}`);
});

// Paired with railway.toml's drainingSeconds and startCommand (invoking node
// directly, not through `npm start`, so this handler actually runs at all —
// see the comments there). Stops accepting new connections immediately, but
// lets any pipeline run already in flight finish rather than orphaning it
// mid-run — that's what silently "hangs" the client (its EventSource just
// gets 404s from the new container's empty activeRuns and can't recover).
// Bounded so this can never itself become the reason SIGKILL arrives before
// exit: this must finish comfortably inside drainingSeconds.
const GRACEFUL_SHUTDOWN_MAX_WAIT_MS = 200 * 1000;
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const runsInFlight = () => [...activeRuns.values()].filter((run) => !run.finished).length;
  console.error(`[serve-site] ${signal} received; draining ${runsInFlight()} in-flight run(s)...`);
  server.close(); // stop accepting new connections; open sockets (incl. SSE) are left alone

  const deadline = Date.now() + GRACEFUL_SHUTDOWN_MAX_WAIT_MS;
  while (runsInFlight() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (runsInFlight() > 0) {
    console.error(`[serve-site] shutdown wait exhausted with ${runsInFlight()} run(s) still active; exiting anyway.`);
  }

  await shutdownObservability();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => gracefulShutdown(signal));
}
