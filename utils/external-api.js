/**
 * Shared wrapper for outbound calls to external dependencies (MediaWiki, Pixabay,
 * ...). One place that does timing, bounded retry-with-backoff on transient
 * failures (timeout/429/5xx), and telemetry recording, so a new external API
 * gets consistent observability "for free" instead of every call site
 * reinventing it.
 *
 * Deliberately separate from utils/grok.js's retry logic: LLM JSON-repair
 * retries are a different concept (the model produced bad output) from a
 * transport-level retry here (the network/service failed).
 */

import { recordExternalCallMetric, recordRetryMetric, recordRateLimitMetric } from '../imright/scripts/observability.js';
import { recordExternalCallAttempt, addTraceEvent } from '../imright/scripts/interaction-context.js';

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 5000;

/** Thrown by call sites for a non-2xx HTTP response so the wrapper can classify/retry it. */
export class HttpStatusError extends Error {
  constructor(status, message, { retryAfterSeconds } = {}) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Convenience for call sites: AbortSignal that fires after ms. */
export function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

/** Classifies a thrown error into a low-cardinality status for metrics/retry decisions.
 * Exported so utils/grok.js can reuse the same classification for LLM transport retries. */
export function classifyTransportError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'timeout';
  if (typeof error?.status === 'number') {
    if (error.status === 429) return 'rate_limited';
    if (error.status >= 500) return 'server_error';
    if (error.status >= 400) return 'client_error';
  }
  return 'network_error';
}

export function isRetryableTransportStatus(status) {
  return status === 'timeout' || status === 'rate_limited' || status === 'server_error' || status === 'network_error';
}

const classify = classifyTransportError;
const defaultIsRetryable = isRetryableTransportStatus;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} params
 * @param {string} params.service - Low-cardinality dependency name, e.g. 'mediawiki', 'pixabay'.
 * @param {string} params.operation - Low-cardinality operation name, e.g. 'search', 'download'.
 * @param {string} params.pipelineStep - Which pipeline stage this call belongs to.
 * @param {(attempt: number) => Promise<any>} params.fn - Does the actual fetch; throw HttpStatusError for non-2xx.
 * @param {number} [params.maxRetries] - Extra attempts beyond the first (default 1).
 * @param {(status: string) => boolean} [params.isRetryable] - Override retry classification.
 */
export async function callExternalApi({
  service,
  operation,
  pipelineStep,
  fn,
  maxRetries = DEFAULT_MAX_RETRIES,
  isRetryable = defaultIsRetryable,
}) {
  let attempt = 0;
  let lastError;

  while (attempt <= maxRetries) {
    attempt += 1;
    const isRetry = attempt > 1;
    const start = performance.now();
    try {
      const result = await fn(attempt);
      const latencyMs = performance.now() - start;
      recordExternalCallMetric({ service, operation, pipelineStep, status: 'success', latencyMs });
      recordExternalCallAttempt(service, { success: true, isRetry });
      addTraceEvent('external_call', { service, operation, pipelineStep, attempt, status: 'success', latencyMs: Math.round(latencyMs) });
      return result;
    } catch (error) {
      const latencyMs = performance.now() - start;
      const status = classify(error);
      lastError = error;

      recordExternalCallMetric({ service, operation, pipelineStep, status, latencyMs });
      recordExternalCallAttempt(service, {
        success: false,
        isRetry,
        rateLimited: status === 'rate_limited',
        timedOut: status === 'timeout',
      });
      addTraceEvent('external_call', {
        service,
        operation,
        pipelineStep,
        attempt,
        status,
        latencyMs: Math.round(latencyMs),
        error: String(error?.message ?? error).slice(0, 200),
      });
      if (status === 'rate_limited') {
        recordRateLimitMetric({ service, operation });
      }

      const canRetry = isRetryable(status) && attempt <= maxRetries;
      if (!canRetry) throw error;

      recordRetryMetric({ kind: 'external', service, operation, pipelineStep, reason: status });
      const retryAfterMs = Number.isFinite(error?.retryAfterSeconds)
        ? Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS)
        : Math.min(DEFAULT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      await sleep(retryAfterMs + Math.random() * 100);
    }
  }

  throw lastError;
}
