#!/usr/bin/env node
/**
 * Landing-page server for imright.
 * Serves the static site (index.html, tabloid output, debug pages, counterarguments)
 * and exposes /api/run + /api/stream/:runId so the landing page can drive runPipeline
 * without duplicating any pipeline logic.
 *
 * Usage: node imright/scripts/serve-site.js [port]
 * Default port: 3758 (kept distinct from the CLI's 3757 so the CLI's port-kill
 * in imright/cli.js does not terminate this server).
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { runPipeline } from '../index.js';
import { loadEnv } from '../load-env.js';
import { slugify } from '../utils.js';
import {
  safeCompare,
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

loadEnv();
startObservability();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
if (!SITE_PASSWORD) {
  console.error(
    '[serve-site] SITE_PASSWORD is not set. Refusing to start unprotected — set it in env.local (or the deploy environment) and restart.'
  );
  process.exit(1);
}
// Generated fresh per process: signs the login cookie so it can't be forged.
// Restarting the server invalidates existing sessions, which is fine for a
// simple password gate like this one.
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE_NAME = 'imright_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * High-level mode the server runs in. Each mode bundles a set of defaults
 * (bind host, port, and — in the future — things like caching headers,
 * logging verbosity, compression, etc.).
 *
 *   local - 127.0.0.1 (default). Only reachable from this machine.
 *   lan   - 0.0.0.0. Reachable from any host on the local network, handy
 *           for testing on a phone or a second laptop.
 *   prod  - 0.0.0.0. Placeholder for production defaults; extend
 *           MODE_DEFAULTS below as real prod config (caching, logging,
 *           etc.) gets added.
 *
 * Pick a mode in one of three ways:
 *   1) `npm run dev`  /  `npm run dev:lan`  /  `npm run start:prod`
 *   2) SERVE_MODE=lan npm run dev
 *   3) put `SERVE_MODE=lan` in env.local (sticky for this machine)
 *
 * Individual env vars (SERVE_HOST, PORT) still override the mode's
 * defaults, so one-off tweaks don't require inventing a new mode.
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

// Precedence: explicit CLI arg (port) > env var > mode default.
const PORT = parseInt(
  process.argv[2] || process.env.PORT || String(modeConfig.port),
  10
);
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
    console.error(
      `[serve-site] ${COLOR_SCHEMES_PATH} has no "schemes" object; using hard-coded fallback layers.`
    );
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

/**
 * Render index.html with the placeholder replaced by the active scheme's
 * background. Done per-request (cheap I/O, small file) so editing
 * config/app_config.json or config/color_schemes.json takes effect on the
 * next reload without a server restart.
 */
function serveLandingPage(response) {
  const landingPagePath = path.join(PROJECT_ROOT, 'index.html');
  fs.readFile(landingPagePath, 'utf8', (readError, rawHtml) => {
    if (readError) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Failed to read index.html');
      return;
    }
    const activeHomeBackgroundCss = resolveActiveHomeBackground();
    const renderedHtml = rawHtml.split(ACTIVE_HOME_BACKGROUND_PLACEHOLDER).join(activeHomeBackgroundCss);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    response.end(renderedHtml);
  });
}

/**
 * Render login.html the same way serveLandingPage renders index.html, so the
 * password gate matches the site's background/branding.
 */
function serveLoginPage(response, statusCode = 200) {
  const loginPagePath = path.join(PROJECT_ROOT, 'imright', 'login.html');
  fs.readFile(loginPagePath, 'utf8', (readError, rawHtml) => {
    if (readError) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Failed to read login.html');
      return;
    }
    const activeHomeBackgroundCss = resolveActiveHomeBackground();
    const renderedHtml = rawHtml.split(ACTIVE_HOME_BACKGROUND_PLACEHOLDER).join(activeHomeBackgroundCss);
    response.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(renderedHtml);
  });
}

function isAuthenticated(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return false;
  return verifySessionToken(token, SESSION_SECRET);
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

/**
 * POST /api/login { password }
 * On success, sets a signed session cookie; on failure, records the attempt
 * against the caller's IP so repeated wrong guesses eventually get locked out.
 */
async function handleApiLogin(request, response) {
  const clientIp = getClientIp(request);

  if (isLockedOut(clientIp)) {
    recordTrafficRequest('blocked');
    sendJson(response, 429, { error: 'too_many_attempts' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { error: 'invalid_json' });
    return;
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || !safeCompare(password, SITE_PASSWORD)) {
    recordLoginFailure(clientIp);
    sendJson(response, 401, { error: 'invalid_password' });
    return;
  }

  recordLoginSuccess(clientIp);
  const token = createSessionToken(SESSION_SECRET, SESSION_MAX_AGE_MS);
  // appendSetCookie (not setHeader) so this doesn't clobber the visitor/session
  // identity cookies already queued on this response by resolveIdentity().
  appendSetCookie(response, buildSessionCookie(SESSION_COOKIE_NAME, token, SESSION_MAX_AGE_MS, SERVE_MODE === 'prod'));
  sendJson(response, 200, { ok: true });
}

/** POST /api/logout — clears the session cookie. */
function handleApiLogout(response) {
  appendSetCookie(response, buildExpiredCookie(SESSION_COOKIE_NAME, SERVE_MODE === 'prod'));
  sendJson(response, 200, { ok: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * In-memory map of runId -> run state.
 * Each run has a subscriber array (SSE response streams) plus a buffered event
 * history so a client that connects a moment after POST /api/run still sees
 * every stage event from the beginning.
 */
const activeRuns = new Map();

function createRunState(slug, articleUrl) {
  return {
    slug,
    articleUrl,
    events: [],
    finished: false,
    subscribers: new Set(),
  };
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

function serveStaticFile(requestUrlPath, response) {
  const urlPath = requestUrlPath === '/' ? '/index.html' : requestUrlPath;
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|$))+/, '');
  const filePath = path.join(PROJECT_ROOT, safePath);

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    const extension = path.extname(filePath);
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024) {
        request.destroy();
        reject(new Error('payload too large'));
      }
    });
    request.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (parseError) {
        reject(parseError);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

/**
 * POST /api/run { claim }
 * Starts runPipeline in the background and returns { runId, slug, articleUrl }.
 * Progress + the onPageReady signal are streamed via /api/stream/:runId.
 */
async function handleApiRun(request, response, identity) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { error: 'invalid_json' });
    return;
  }

  const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
  if (!claim) {
    sendJson(response, 400, { error: 'missing_claim' });
    return;
  }

  const { visitorId, sessionId } = identity;
  const clientIp = getClientIp(request);
  const { suspectedAbuse, duplicateRequest } = checkRunAbuse({ visitorId, ip: clientIp, claim });
  // A visitor tripping the abuse heuristics gets reclassified even if their cookie made
  // them look like a normal browser session — visibility, not enforcement (see README).
  const trafficClass = suspectedAbuse ? 'suspicious_api' : identity.trafficClass;

  const slug = slugify(claim);
  const articleUrl = `/tabloid_generator/output/${slug}.html`;
  const interactionId = crypto.randomUUID();
  const runState = createRunState(slug, articleUrl);
  activeRuns.set(interactionId, runState);
  recordSubmit(slug);
  recordInteractionStarted();
  const submittedAt = performance.now();
  let pipelineResult = null;

  const onProgress = (stepIndex, totalSteps, message) => {
    broadcastEvent(runState, {
      type: 'progress',
      step: stepIndex,
      total: totalSteps,
      name: message,
    });
  };

  const onStepComplete = (stepIndex, totalSteps, message, delta) => {
    // Batched into this interaction's own trace event log (see interaction-context.js) —
    // still one log write at the end, not a separate permanent line per step.
    addTraceEvent('pipeline_step', { step: stepIndex, total: totalSteps, name: message, ...delta });
    broadcastEvent(runState, {
      type: 'stepComplete',
      step: stepIndex,
      total: totalSteps,
      name: message,
    });
  };

  const onPageReady = (readySlug) => {
    recordTimeToReady(performance.now() - submittedAt, readySlug);
    broadcastEvent(runState, {
      type: 'ready',
      url: `/tabloid_generator/output/${readySlug}.html`,
    });
  };

  sendJson(response, 200, { runId: interactionId, slug, articleUrl });

  /** Builds and ships the Layer 3 interaction summary from whatever the interaction
   * context accumulated, regardless of how far the pipeline got before success/failure. */
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

  // Run the pipeline detached from the HTTP response so the browser can start
  // listening to SSE. Errors are broadcast and then logged. Wrapped in its own
  // interaction context so every LLM/external call inside runPipeline attributes
  // its tokens/cost/retries back to this one interaction (see interaction-context.js).
  runWithInteractionContext({ interactionId, visitorId, sessionId, trafficClass }, () => {
    setClaimText(claim);
    decideVerboseSampling({ visitorId });

    return runPipeline(claim, { onProgress, onStepComplete, onPageReady })
      .then((result) => {
        pipelineResult = result;
        completeInteraction(true);
        broadcastEvent(runState, { type: 'done' });
      })
      .catch((pipelineError) => {
        console.error('[serve-site] pipeline error:', pipelineError);
        completeInteraction(false);
        broadcastEvent(runState, {
          type: 'error',
          message: pipelineError?.message ?? 'Pipeline failed',
        });
      })
      .finally(() => {
        runState.finished = true;
        // Close all subscribers. Give browsers a moment to process the final event.
        setTimeout(() => {
          for (const subscriberResponse of runState.subscribers) {
            try {
              subscriberResponse.end();
            } catch {
              // ignore
            }
          }
          runState.subscribers.clear();
          // Keep runState cached briefly for any late replays, then drop it.
          setTimeout(() => activeRuns.delete(interactionId), 60_000);
        }, 250);
      });
  });
}

/**
 * GET /api/stream/:runId
 * Server-Sent Events stream. Immediately replays buffered events for the run,
 * then pushes any future events until the run finishes.
 */
function handleApiStream(runId, response) {
  const runState = activeRuns.get(runId);
  if (!runState) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Unknown runId');
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(': connected\n\n');

  for (const bufferedEvent of runState.events) {
    response.write(`data: ${JSON.stringify(bufferedEvent)}\n\n`);
  }

  if (runState.finished) {
    response.end();
    return;
  }

  runState.subscribers.add(response);
  response.on('close', () => {
    runState.subscribers.delete(response);
  });
}

const server = http.createServer(async (request, response) => {
  const urlPath = (request.url ?? '/').split('?')[0] || '/';
  const cookies = parseCookies(request.headers.cookie);

  // Identity + traffic classification happen for every request, before auth/routing,
  // so scanner noise and unauthenticated probes are counted too — that's the whole
  // point of distinguishing "harmless scanner" from "real product traffic" from
  // "suspicious traffic that actually invokes expensive work" (see identity.js).
  const { visitorId, sessionId, isNewVisitor, isNewSession } = resolveIdentity(request, response, cookies, {
    secure: SERVE_MODE === 'prod',
  });
  recordVisitor(isNewVisitor);
  if (isNewSession) recordSessionStart();
  const trafficClass = classifyTraffic({
    method: request.method,
    urlPath,
    userAgent: request.headers['user-agent'],
    hasVisitorCookie: !isNewVisitor,
  });
  recordTrafficRequest(trafficClass);

  // Login/logout must be reachable without a session, everything else is gated below.
  if (request.method === 'POST' && urlPath === '/api/login') {
    await handleApiLogin(request, response);
    return;
  }

  if (request.method === 'POST' && urlPath === '/api/logout') {
    handleApiLogout(response);
    return;
  }

  if (!isAuthenticated(request)) {
    const isBotReadRequest =
      (request.method === 'GET' || request.method === 'HEAD') &&
      (urlPath === '/ads.txt' || isGoogleBotRequest(request));

    if (!isBotReadRequest) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        serveLoginPage(response);
      } else {
        sendJson(response, 401, { error: 'unauthenticated' });
      }
      return;
    }
    // Google crawler (or a request for /ads.txt): fall through to normal
    // GET/HEAD routing below without a session.
  }

  if (request.method === 'POST' && urlPath === '/api/run') {
    await handleApiRun(request, response, { visitorId, sessionId, trafficClass });
    return;
  }

  if (request.method === 'GET' && urlPath.startsWith('/api/stream/')) {
    const runId = urlPath.slice('/api/stream/'.length);
    handleApiStream(runId, response);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Method Not Allowed');
    return;
  }

  if (urlPath === '/' || urlPath === '/index.html') {
    recordPageView('landing');
    serveLandingPage(response);
    return;
  }

  const articleMatch = urlPath.match(/^\/tabloid_generator\/output\/([^/]+)\.html$/);
  if (articleMatch) {
    recordPageView('article', { slug: articleMatch[1] });
  }

  serveStaticFile(urlPath, response);
});

server.listen(PORT, SERVE_HOST, () => {
  const url = `http://127.0.0.1:${PORT}`;
  process.stdout.write(`${url}\n`);
  const reachability =
    SERVE_HOST === '0.0.0.0'
      ? 'reachable on the local network'
      : 'local machine only';
  console.error(
    `[serve-site] mode=${SERVE_MODE} listening on ${SERVE_HOST}:${PORT} (${reachability}); open ${url}`
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await shutdownObservability();
    process.exit(0);
  });
}
