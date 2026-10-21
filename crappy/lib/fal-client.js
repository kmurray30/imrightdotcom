/**
 * Minimal fal.ai queue client: submit, poll, fetch result, download media.
 *
 * Deliberately not built on utils/external-api.js: that helper drags in the
 * OTel SDK at import time and retries the whole operation, which for a
 * queued (paid) job would mean re-submitting and paying again. Here only the
 * individual HTTP calls retry; a submitted job is polled until it settles.
 */
import fs from 'fs';
import path from 'path';

export const QUEUE_BASE = 'https://queue.fal.run';
export const OPENAPI_BASE = 'https://fal.ai/api/openapi/queue/openapi.json';

export class FalHttpError extends Error {
  constructor(status, body, url) {
    super(`fal HTTP ${status} from ${url}: ${String(body).slice(0, 400)}`);
    this.name = 'FalHttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function getFalKey() {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('FAL_KEY is not configured (env.local or shell env).');
  return key;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * fetch + JSON with exponential backoff on 429/5xx/network/timeout.
 */
export async function fetchJsonWithRetry(url, init = {}, { retries = 3, timeoutMs = 30_000, log } = {}) {
  let attempt = 0;
  let delay = 1000;
  for (;;) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      if (!response.ok) throw new FalHttpError(response.status, text, url);
      return text ? JSON.parse(text) : {};
    } catch (error) {
      const retryable = error instanceof FalHttpError ? isRetryableStatus(error.status) : true;
      if (!retryable || attempt >= retries) throw error;
      attempt++;
      log?.(`retry ${attempt}/${retries} in ${delay} ms: ${error.message}`);
      await sleep(delay + Math.floor(Math.random() * 250));
      delay *= 2;
    }
  }
}

/**
 * Submit a job to the fal queue and wait for its result.
 * @returns {Promise<{ requestId: string, result: any, elapsedMs: number }>}
 */
export async function submitAndWait(modelId, body, { pollMs = 3000, maxWaitMs = 600_000, log } = {}) {
  const key = getFalKey();
  const authHeaders = { Authorization: `Key ${key}` };
  const started = Date.now();
  const submitted = await fetchJsonWithRetry(
    `${QUEUE_BASE}/${modelId}`,
    { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { log }
  );
  const requestId = submitted.request_id;
  if (!requestId) {
    throw new Error(`fal submit returned no request_id: ${JSON.stringify(submitted).slice(0, 300)}`);
  }
  const statusUrl = submitted.status_url || `${QUEUE_BASE}/${modelId}/requests/${requestId}/status`;
  const responseUrl = submitted.response_url || `${QUEUE_BASE}/${modelId}/requests/${requestId}`;
  log?.(`submitted ${requestId}`);

  let consecutiveFailures = 0;
  let lastStatus = '';
  while (Date.now() - started < maxWaitMs) {
    let status;
    try {
      status = await fetchJsonWithRetry(statusUrl, { headers: authHeaders }, { retries: 0, log });
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      if (consecutiveFailures > 5) throw error;
      await sleep(pollMs);
      continue;
    }
    const label = `${status.status}${status.queue_position != null ? ` (queue position ${status.queue_position})` : ''}`;
    if (label !== lastStatus) {
      log?.(`${requestId}: ${label}`);
      lastStatus = label;
    }
    if (status.status === 'COMPLETED') {
      const result = await fetchJsonWithRetry(responseUrl, { headers: authHeaders }, { log });
      return { requestId, result, elapsedMs: Date.now() - started };
    }
    if (status.status === 'FAILED' || status.status === 'CANCELLED' || status.error) {
      throw new Error(`fal request ${requestId} ${status.status || 'failed'}: ${JSON.stringify(status).slice(0, 600)}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`fal request ${requestId} did not complete within ${maxWaitMs} ms`);
}

/** Download a result URL to disk (fal media URLs expire, so do this promptly). */
export async function downloadToFile(url, dest, { retries = 3, timeoutMs = 120_000, log } = {}) {
  let attempt = 0;
  let delay = 1000;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new FalHttpError(response.status, await response.text(), url);
      const bytes = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      return { bytes: bytes.length, contentType: response.headers.get('content-type') };
    } catch (error) {
      const retryable = error instanceof FalHttpError ? isRetryableStatus(error.status) : true;
      if (!retryable || attempt >= retries) throw error;
      attempt++;
      log?.(`download retry ${attempt}/${retries}: ${error.message}`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

export function fileToDataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** Replace data URIs in a request body with a short placeholder for logs/JSON on disk. */
export function elideDataUris(value) {
  if (typeof value === 'string') {
    return value.startsWith('data:') ? `<data-uri ${value.length} chars>` : value;
  }
  if (Array.isArray(value)) return value.map(elideDataUris);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elideDataUris(v)]));
  }
  return value;
}

export async function fetchOpenApiSchema(modelId, { timeoutMs = 10_000 } = {}) {
  const url = `${OPENAPI_BASE}?endpoint_id=${encodeURIComponent(modelId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new FalHttpError(response.status, await response.text(), url);
  return response.json();
}

/** Pull the input schemas (field names, required list, enums) out of an OpenAPI doc. */
export function summarizeSchema(schema) {
  const schemas = schema?.components?.schemas ?? {};
  const out = [];
  for (const [name, def] of Object.entries(schemas)) {
    if (!/input/i.test(name) || !def?.properties) continue;
    const fields = Object.entries(def.properties).map(([field, prop]) => {
      const bits = [field];
      if (prop.type) bits.push(prop.type);
      if (prop.enum) bits.push(`enum ${JSON.stringify(prop.enum)}`);
      if (prop.default !== undefined) bits.push(`default ${JSON.stringify(prop.default)}`);
      return bits.join(': ');
    });
    out.push({ name, required: def.required ?? [], fields });
  }
  return out;
}
