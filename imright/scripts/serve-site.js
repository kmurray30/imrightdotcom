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

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { runPipeline } from '../index.js';
import { slugify } from '../utils.js';
import { loadEnv } from '../load-env.js';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_PORT = 3758;
const PORT = parseInt(process.argv[2] || String(DEFAULT_PORT), 10);

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
async function handleApiRun(request, response) {
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

  const slug = slugify(claim);
  const articleUrl = `/tabloid_generator/output/${slug}.html`;
  const runId = crypto.randomUUID();
  const runState = createRunState(slug, articleUrl);
  activeRuns.set(runId, runState);

  const onProgress = (stepIndex, totalSteps, message) => {
    broadcastEvent(runState, {
      type: 'progress',
      step: stepIndex,
      total: totalSteps,
      name: message,
    });
  };

  const onStepComplete = (stepIndex, totalSteps, message) => {
    broadcastEvent(runState, {
      type: 'stepComplete',
      step: stepIndex,
      total: totalSteps,
      name: message,
    });
  };

  const onPageReady = (readySlug) => {
    broadcastEvent(runState, {
      type: 'ready',
      url: `/tabloid_generator/output/${readySlug}.html`,
    });
  };

  sendJson(response, 200, { runId, slug, articleUrl });

  // Run the pipeline detached from the HTTP response so the browser can start
  // listening to SSE. Errors are broadcast and then logged.
  runPipeline(claim, { onProgress, onStepComplete, onPageReady })
    .then(() => {
      broadcastEvent(runState, { type: 'done' });
    })
    .catch((pipelineError) => {
      console.error('[serve-site] pipeline error:', pipelineError);
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
        setTimeout(() => activeRuns.delete(runId), 60_000);
      }, 250);
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

  if (request.method === 'POST' && urlPath === '/api/run') {
    await handleApiRun(request, response);
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

  serveStaticFile(urlPath, response);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  process.stdout.write(`${url}\n`);
  console.error(`[serve-site] listening on ${url}`);
});
