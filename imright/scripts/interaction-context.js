/**
 * Per-interaction telemetry context, propagated implicitly via AsyncLocalStorage
 * so shared helpers (callGrok, MediaWiki fetch, Pixabay fetch, ...) can attribute
 * their work to the right interaction/visitor/session without every call site
 * threading IDs through function signatures.
 *
 * Nothing here talks to Grafana directly — it just accumulates counts for the
 * duration of one /api/run (or CLI) invocation. imright/scripts/observability.js
 * reads the final accumulator via getSummary() to emit metrics/logs once the
 * interaction finishes.
 */

import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage();

/** Fallback accumulator used when code runs outside any interaction context
 * (standalone module scripts, tests). Keeps old callers working unmodified. */
const fallbackStore = createStore({
  interactionId: null,
  visitorId: null,
  sessionId: null,
  trafficClass: 'unknown',
});

function createStore(identity) {
  return {
    ...identity,
    startedAt: Date.now(),
    verbose: false,
    claimText: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    llm: { calls: 0, failures: 0, retries: 0 },
    external: {}, // service -> { calls, failures, retries, rateLimited }
    events: [], // only appended to when verbose
  };
}

/** Run fn with a fresh interaction context. identity: { interactionId, visitorId, sessionId, trafficClass }. */
export function runWithInteractionContext(identity, fn) {
  return storage.run(createStore(identity), fn);
}

/** Returns the active store, or a shared fallback if called outside a context. */
export function getContext() {
  return storage.getStore() ?? fallbackStore;
}

const MAX_EVENTS = 500; // defensive cap; a normal interaction has ~10-30 events

/**
 * Every interaction accumulates its own step/call event log and claim text in
 * memory for the duration of the request regardless of sampling — that's cheap
 * (one request, a few dozen small entries). The *sampling* decision only
 * controls whether this detail actually gets written to Loki at the end
 * (recordInteractionComplete): either because this interaction was
 * pre-selected (setVerbose, based on rolling traffic volume) or, just as
 * often, because it turned out to be an error/anomaly we couldn't have
 * predicted in advance. See imright/scripts/verbosity.js.
 */
export function setVerbose() {
  getContext().verbose = true;
}

export function setClaimText(claimText) {
  getContext().claimText = claimText;
}

export function isVerbose() {
  return getContext().verbose === true;
}

export function addTraceEvent(kind, detail) {
  const store = getContext();
  if (store.events.length >= MAX_EVENTS) return;
  store.events.push({ t: Date.now() - store.startedAt, kind, ...detail });
}

function externalBucket(store, service) {
  if (!store.external[service]) {
    store.external[service] = { calls: 0, failures: 0, retries: 0, rateLimited: 0, timeouts: 0 };
  }
  return store.external[service];
}

/** Call once per LLM request attempt (success or failure). */
export function recordLlmCallAttempt({ success, isRetry }) {
  const store = getContext();
  store.llm.calls += 1;
  if (isRetry) store.llm.retries += 1;
  if (!success) store.llm.failures += 1;
}

/** Marks a retry that isn't itself a new transport attempt at the callGrok level —
 * e.g. callGrokJson re-calling callGrok from scratch because the model's output was
 * unparseable. The re-call already increments `calls` via recordLlmCallAttempt; this
 * just tags it as a retry for interaction-level retry-rate reporting. */
export function markLlmRetry() {
  getContext().llm.retries += 1;
}

export function addTokenUsage(inputTokens, outputTokens) {
  const store = getContext();
  store.tokenUsage.inputTokens += inputTokens ?? 0;
  store.tokenUsage.outputTokens += outputTokens ?? 0;
}

/** Call once per external-API request attempt (MediaWiki, Pixabay, link checker, ...). */
export function recordExternalCallAttempt(service, { success, isRetry, rateLimited, timedOut }) {
  const store = getContext();
  const bucket = externalBucket(store, service);
  bucket.calls += 1;
  if (isRetry) bucket.retries += 1;
  if (!success) bucket.failures += 1;
  if (rateLimited) bucket.rateLimited += 1;
  if (timedOut) bucket.timeouts += 1;
}

/** Compact snapshot for the Layer 3 interaction summary. Safe to call any time. */
export function getSummary() {
  const store = getContext();
  return {
    interactionId: store.interactionId,
    visitorId: store.visitorId,
    sessionId: store.sessionId,
    trafficClass: store.trafficClass,
    tokenUsage: { ...store.tokenUsage },
    llm: { ...store.llm },
    external: Object.fromEntries(Object.entries(store.external).map(([k, v]) => [k, { ...v }])),
    verbose: store.verbose,
    claimText: store.claimText,
    events: store.events,
  };
}
