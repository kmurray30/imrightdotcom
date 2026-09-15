/**
 * Grafana Cloud observability via OTLP -> Loki (logs) + Prometheus (metrics).
 *
 * Three layers, matching the product's telemetry design:
 *  - Layer 1: always-on, low-cardinality counters/histograms (this file's
 *    recordXxxMetric functions), cheap to keep forever regardless of traffic.
 *  - Layer 2: per-interaction distributions (cost/tokens/calls/retries/latency),
 *    recorded once per completed interaction into the same histograms so
 *    Grafana's histogram_quantile gives p50/p90/p95/p99 for free.
 *  - Layer 3: one compact structured log per interaction (recordInteractionComplete),
 *    shipped to Loki for ad hoc querying (e.g. "top 5% of spend"). A richer
 *    variant is emitted only for sampled/anomalous interactions (see
 *    imright/scripts/verbosity.js) — never one log line per pipeline step/call.
 *
 * Metric labels are deliberately restricted to low-cardinality dimensions
 * (provider, model, pipeline_step, service, operation, status, error_type,
 * traffic_class, tag). IDs (interaction/visitor/session), claim text, and raw
 * error strings only ever go into log attributes, never metric labels.
 *
 * If OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS aren't set, this is a no-op and log()
 * just goes to the console.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { ExportResultCode } from '@opentelemetry/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const THRESHOLDS_PATH = path.join(PROJECT_ROOT, 'config', 'telemetry_thresholds.json');

// Without this, failed OTLP exports (bad auth, network errors, etc.) are silently
// swallowed by the SDK instead of showing up anywhere.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const SERVICE_NAME = 'imright';
const HEARTBEAT_INTERVAL_MS = 60_000;

// The OTel SDK's default histogram buckets (0,5,10,25,50,75,100,250,...) are tuned for
// generic millisecond latencies and would dump nearly all of this app's values (a few
// seconds to a couple minutes) into one or two buckets, making p50/p90/p95/p99 useless.
const MS_BUCKETS_SHORT = [200, 500, 1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 45000, 60000, 90000];
const MS_BUCKETS_EXTERNAL = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 15000, 20000];

let loggerProvider = null;
let otelLogger = null;
let meterProvider = null;
let heartbeatTimer = null;

// --- metric instruments (populated in startObservability) ---
let heartbeatCounter = null;
let pageViewCounter = null;
let submitCounter = null;
let httpRequestCounter = null;
let visitorCounter = null;
let sessionCounter = null;
let interactionStartedCounter = null;
let interactionCompletedCounter = null;
let interactionTagCounter = null;
let timeToReadyHistogram = null;

let llmCallCounter = null;
let llmTokenCounter = null;
let llmCostCounter = null;
let llmLatencyHistogram = null;

let externalCallCounter = null;
let externalLatencyHistogram = null;
let externalRateLimitCounter = null;
let retryCounter = null;

let interactionCostHistogram = null;
let interactionTokensHistogram = null;
let interactionLlmCallsHistogram = null;
let interactionLlmRetriesHistogram = null;
let interactionExternalCallsHistogram = null;
let interactionDurationHistogram = null;

/** Best-effort deployed version, used to correlate metrics/logs with a deploy.
 * Railway sets RAILWAY_GIT_COMMIT_SHA automatically for git-based deploys. */
function resolveServiceVersion() {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

/** OTEL_EXPORTER_OTLP_HEADERS is comma-separated key=value pairs, e.g. "Authorization=Basic abc123". */
function parseOtlpHeaders(headersRaw) {
  const headers = {};
  for (const part of headersRaw.split(',')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) continue;
    headers[part.slice(0, eqIndex).trim()] = part.slice(eqIndex + 1).trim();
  }
  return headers;
}

/** Builds a signal-specific OTLP URL and checks it parses, without letting the exporter throw synchronously on a bad one. */
function buildOtlpUrl(endpoint, signalPath) {
  const url = `${endpoint.replace(/\/$/, '')}${signalPath}`;
  try {
    new URL(url); // eslint-disable-line no-new -- validation only
    return url;
  } catch {
    return null;
  }
}

/**
 * Wraps an OTLP exporter so every real export attempt logs its actual outcome
 * (accepted vs. rejected, with the real error) to the console — visible in
 * Railway's logs. Without this, a failed export is invisible unless it happens
 * to trip OTel's own internal diagnostics.
 */
function withExportLogging(exporter, label) {
  const originalExport = exporter.export.bind(exporter);
  exporter.export = (items, resultCallback) => {
    originalExport(items, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        console.error(`[observability] ${label} export: accepted by Grafana`);
      } else {
        console.error(`[observability] ${label} export: REJECTED - ${result.error?.message ?? result.error ?? 'unknown error'}`);
      }
      resultCallback(result);
    });
  };
  return exporter;
}

function severityFor(level) {
  if (level === 'error') return SeverityNumber.ERROR;
  if (level === 'warn') return SeverityNumber.WARN;
  return SeverityNumber.INFO;
}

/** Log to the console always, and to Grafana Loki when observability is enabled. */
export function log(level, message, attributes = {}) {
  console.error(`[${level}] ${message}`);
  if (!otelLogger) return;
  otelLogger.emit({
    severityNumber: severityFor(level),
    severityText: level.toUpperCase(),
    body: message,
    attributes,
  });
}

/**
 * Like log(), but for records meant to be queried with LogQL `| json` in Grafana
 * (interaction_summary/interaction_trace). Grafana Cloud's OTLP->Loki ingestion
 * puts log record attributes into Structured Metadata rather than the log line
 * text, which is queryable too but is a different LogQL idiom and harder to
 * verify sight-unseen — so the full record is also JSON-encoded straight into
 * the log body, guaranteeing `| json` works regardless of how attributes surface.
 * The record is small (no prompts/responses), so this near-doubling of one log
 * line's size is a trivial cost for not having to guess.
 */
export function logStructured(level, message, record) {
  const line = JSON.stringify({ message, ...record });
  console.error(`[${level}] ${message} ${line}`);
  if (!otelLogger) return;
  otelLogger.emit({
    severityNumber: severityFor(level),
    severityText: level.toUpperCase(),
    body: line,
    attributes: record,
  });
}

/** Sets up OTLP logging + metrics and starts the heartbeat. Safe to call once at server startup. */
export function startObservability() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headersRaw = process.env.OTEL_EXPORTER_OTLP_HEADERS;

  if (!endpoint || !headersRaw) {
    console.error('[observability] OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS not set; Grafana observability disabled (console only).');
    return;
  }

  const headers = parseOtlpHeaders(headersRaw);
  const resource = resourceFromAttributes({
    'service.name': SERVICE_NAME,
    'service.version': resolveServiceVersion(),
    'deployment.environment': process.env.SERVE_MODE || 'local',
  });

  const logsUrl = buildOtlpUrl(endpoint, '/v1/logs');
  if (!logsUrl) {
    console.error(`[observability] OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL ("${endpoint}"); Grafana observability disabled (console only).`);
    return;
  }

  try {
    loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({ exporter: withExportLogging(new OTLPLogExporter({ url: logsUrl, headers }), 'logs') }),
      ],
    });
    otelLogger = loggerProvider.getLogger(SERVICE_NAME);
  } catch (setupError) {
    console.error(`[observability] failed to set up Grafana logging; continuing with console only: ${setupError.message}`);
    loggerProvider = null;
    otelLogger = null;
  }

  const metricsUrl = buildOtlpUrl(endpoint, '/v1/metrics');
  try {
    if (!metricsUrl) throw new Error(`OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL ("${endpoint}")`);
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: withExportLogging(new OTLPMetricExporter({ url: metricsUrl, headers }), 'metrics'),
          exportIntervalMillis: HEARTBEAT_INTERVAL_MS,
        }),
      ],
    });
    const meter = meterProvider.getMeter(SERVICE_NAME);

    heartbeatCounter = meter.createCounter('imright.heartbeat', {
      description: 'Incremented once per heartbeat tick; used to validate the Grafana metrics pipeline.',
    });
    pageViewCounter = meter.createCounter('imright.page_view', {
      description: 'Page views, labeled by page type (landing, article).',
    });
    submitCounter = meter.createCounter('imright.submit', {
      description: 'Times a user clicked submit to start a pipeline run.',
    });
    httpRequestCounter = meter.createCounter('imright.http.requests', {
      description: 'Every inbound HTTP request, labeled by traffic_class (page, api_run, scanner_probe, known_crawler, suspicious_api, blocked).',
    });
    visitorCounter = meter.createCounter('imright.visitors', {
      description: 'Visitor-id cookie observed, labeled by type (new, returning).',
    });
    sessionCounter = meter.createCounter('imright.sessions', {
      description: 'New session-id issued (session cookie absent or expired).',
    });
    interactionStartedCounter = meter.createCounter('imright.interaction.started', {
      description: 'Interactions (pipeline runs) started.',
    });
    interactionCompletedCounter = meter.createCounter('imright.interaction.completed', {
      description: 'Interactions finished, labeled by status (success, error).',
    });
    interactionTagCounter = meter.createCounter('imright.interaction.tags', {
      description: 'Anomaly tags applied to completed interactions (an interaction may contribute to multiple tags).',
    });
    timeToReadyHistogram = meter.createHistogram('imright.pipeline.time_to_ready_ms', {
      description: 'Time from submit to the article page being ready to view, in ms.',
      advice: { explicitBucketBoundaries: MS_BUCKETS_SHORT },
    });

    llmCallCounter = meter.createCounter('imright.llm.calls', {
      description: 'LLM API calls, labeled by provider, model, pipeline_step, status (success, error).',
    });
    llmTokenCounter = meter.createCounter('imright.llm.tokens', {
      description: 'LLM tokens, labeled by provider, model, pipeline_step, token_type (input, output).',
    });
    llmCostCounter = meter.createCounter('imright.llm.cost_usd', {
      description: 'Estimated LLM spend in USD, labeled by provider, model, pipeline_step.',
    });
    llmLatencyHistogram = meter.createHistogram('imright.llm.latency_ms', {
      description: 'LLM call latency in ms, labeled by provider, model, pipeline_step.',
      advice: { explicitBucketBoundaries: MS_BUCKETS_SHORT },
    });

    externalCallCounter = meter.createCounter('imright.external.calls', {
      description: 'Outbound calls to external dependencies (MediaWiki, Pixabay, ...), labeled by service, operation, status.',
    });
    externalLatencyHistogram = meter.createHistogram('imright.external.latency_ms', {
      description: 'External dependency call latency in ms, labeled by service, operation.',
      advice: { explicitBucketBoundaries: MS_BUCKETS_EXTERNAL },
    });
    externalRateLimitCounter = meter.createCounter('imright.external.rate_limited', {
      description: '429/rate-limit responses from external dependencies, labeled by service, operation.',
    });
    retryCounter = meter.createCounter('imright.retries', {
      description: 'Retries of any kind, labeled by kind (llm_transport, llm_json, external), pipeline_step, reason.',
    });

    interactionCostHistogram = meter.createHistogram('imright.interaction.cost_usd', {
      description: 'Total estimated LLM cost in USD per completed interaction (distribution — use for p50/p90/p95/p99).',
      advice: { explicitBucketBoundaries: [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5] },
    });
    interactionTokensHistogram = meter.createHistogram('imright.interaction.tokens_total', {
      description: 'Total LLM tokens (input+output) per completed interaction.',
      advice: { explicitBucketBoundaries: [1000, 2500, 5000, 10000, 20000, 30000, 50000, 75000, 100000, 150000, 250000] },
    });
    interactionLlmCallsHistogram = meter.createHistogram('imright.interaction.llm_calls', {
      description: 'Number of LLM calls per completed interaction.',
      advice: { explicitBucketBoundaries: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30] },
    });
    interactionLlmRetriesHistogram = meter.createHistogram('imright.interaction.llm_retries', {
      description: 'Number of LLM retries per completed interaction.',
      advice: { explicitBucketBoundaries: [0, 1, 2, 3, 4, 5, 8, 12] },
    });
    interactionExternalCallsHistogram = meter.createHistogram('imright.interaction.external_calls', {
      description: 'Number of external-dependency calls per completed interaction.',
      advice: { explicitBucketBoundaries: [5, 10, 15, 20, 30, 40, 60, 80, 100, 150] },
    });
    interactionDurationHistogram = meter.createHistogram('imright.interaction.duration_ms', {
      description: 'Wall-clock duration of a completed interaction, in ms.',
      advice: { explicitBucketBoundaries: [10000, 20000, 30000, 45000, 60000, 90000, 120000, 180000, 300000] },
    });
  } catch (setupError) {
    console.error(`[observability] failed to set up Grafana metrics; continuing without metrics: ${setupError.message}`);
    meterProvider = null;
  }

  console.error(
    `[observability] Grafana logging=${otelLogger ? 'enabled' : 'disabled'}, metrics=${heartbeatCounter ? 'enabled' : 'disabled'} (service.name=${SERVICE_NAME}, service.version=${resolveServiceVersion()})`
  );

  log('info', 'imright server started');

  heartbeatTimer = setInterval(() => {
    log('info', 'heartbeat');
    heartbeatCounter?.add(1);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

/** Call when a page is loaded (landing page, an article, etc.). */
export function recordPageView(page, attributes = {}) {
  log('info', 'page_view', { page, ...attributes });
  pageViewCounter?.add(1, { page });
}

/** Call when a user submits a claim to start a pipeline run. */
export function recordSubmit(slug) {
  log('info', 'submit', { slug });
  submitCounter?.add(1);
}

/** Call once the article page becomes ready to view, with ms elapsed since submit. */
export function recordTimeToReady(ms, slug) {
  log('info', 'page ready', { slug, timeMs: Math.round(ms) });
  timeToReadyHistogram?.record(ms);
}

/** Call for every inbound HTTP request, before/independent of auth. Never logs individually — counter only. */
export function recordTrafficRequest(trafficClass) {
  httpRequestCounter?.add(1, { traffic_class: trafficClass });
}

/** Call once per request when the visitor-id cookie is read/issued. */
export function recordVisitor(isNew) {
  visitorCounter?.add(1, { type: isNew ? 'new' : 'returning' });
}

/** Call when a new session-id is issued. */
export function recordSessionStart() {
  sessionCounter?.add(1);
}

export function recordInteractionStarted() {
  interactionStartedCounter?.add(1);
}

/** Call once per LLM transport attempt (each retry included). status: 'success' | 'timeout' | 'rate_limited' | 'server_error' | 'client_error' | 'network_error'. */
export function recordLlmCallMetric({ provider, model, pipelineStep, status, latencyMs }) {
  llmCallCounter?.add(1, { provider, model, pipeline_step: pipelineStep, status: status === 'success' ? 'success' : 'error' });
  if (latencyMs != null) llmLatencyHistogram?.record(latencyMs, { provider, model, pipeline_step: pipelineStep });
}

/** Call once per successful LLM response that returned usage — separate from recordLlmCallMetric so a
 * transport retry never double-counts tokens/cost for the same logical call. */
export function recordLlmTokensMetric({ provider, model, pipelineStep, inputTokens, outputTokens, cost }) {
  if (inputTokens) llmTokenCounter?.add(inputTokens, { provider, model, pipeline_step: pipelineStep, token_type: 'input' });
  if (outputTokens) llmTokenCounter?.add(outputTokens, { provider, model, pipeline_step: pipelineStep, token_type: 'output' });
  if (cost) llmCostCounter?.add(cost, { provider, model, pipeline_step: pipelineStep });
}

/** Call once per external-dependency call attempt. status: 'success' | 'timeout' | 'rate_limited' | 'server_error' | 'client_error' | 'network_error'. */
export function recordExternalCallMetric({ service, operation, pipelineStep, status, latencyMs }) {
  externalCallCounter?.add(1, { service, operation, status });
  if (latencyMs != null) externalLatencyHistogram?.record(latencyMs, { service, operation });
}

export function recordRateLimitMetric({ service, operation }) {
  externalRateLimitCounter?.add(1, { service, operation });
  log('warn', 'external dependency rate-limited', { service, operation });
}

/** kind: 'llm_transport' | 'llm_json' | 'external'. */
export function recordRetryMetric({ kind, pipelineStep, reason }) {
  retryCounter?.add(1, { kind, pipeline_step: pipelineStep ?? 'unknown', reason: reason ?? 'unknown' });
}

let cachedThresholds = null;
let cachedThresholdsMtimeMs = 0;

/** Re-reads config/telemetry_thresholds.json when it changes on disk, so thresholds are tunable without a restart. */
export function loadThresholds() {
  try {
    const stat = fs.statSync(THRESHOLDS_PATH);
    if (cachedThresholds && stat.mtimeMs === cachedThresholdsMtimeMs) return cachedThresholds;
    cachedThresholds = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8'));
    cachedThresholdsMtimeMs = stat.mtimeMs;
    return cachedThresholds;
  } catch {
    return cachedThresholds ?? { anomalyThresholds: {} };
  }
}

/** Pure function: interaction summary + thresholds -> anomaly tags. Exported for easy testing. */
export function computeAnomalyTags(summary, thresholds = loadThresholds().anomalyThresholds ?? {}) {
  const tags = [];
  const totalTokens = summary.tokenUsage.inputTokens + summary.tokenUsage.outputTokens;

  if (!summary.success) tags.push('failed');
  if (summary.costUsd >= (thresholds.highCostUsd ?? Infinity)) tags.push('high_cost');
  if (totalTokens >= (thresholds.highTokenCount ?? Infinity)) tags.push('high_token');
  if (summary.llm.calls >= (thresholds.excessiveLlmCalls ?? Infinity)) tags.push('excessive_llm_calls');
  if (summary.llm.retries >= (thresholds.retryHeavyRetries ?? Infinity)) tags.push('retry_heavy');
  if (summary.tokenUsage.inputTokens >= (thresholds.largeInputTokens ?? Infinity)) tags.push('large_input');
  if (summary.tokenUsage.outputTokens >= (thresholds.largeOutputTokens ?? Infinity)) tags.push('large_output');

  const externalEntries = Object.entries(summary.external ?? {});
  if (externalEntries.some(([, v]) => v.rateLimited > 0)) tags.push('rate_limited');
  const mediawiki = summary.external?.mediawiki;
  if (mediawiki?.rateLimited > 0) tags.push('mediawiki_rate_limited');
  const pixabay = summary.external?.pixabay;
  if (pixabay?.rateLimited > 0) tags.push('image_search_rate_limited');

  if (summary.suspectedAbuse) tags.push('suspected_abuse');
  if (summary.duplicateRequest) tags.push('duplicate_request');

  return tags;
}

/**
 * Call once per completed interaction (success or failure) with a compact summary:
 * {
 *   interactionId, visitorId, sessionId, trafficClass, success, durationMs,
 *   stageRows: [{ stage, name, inputTokens, outputTokens, cost, timeMs }],
 *   tokenUsage: { inputTokens, outputTokens }, costUsd,
 *   llm: { calls, failures, retries }, external: { <service>: { calls, failures, retries, rateLimited, timeouts } },
 *   suspectedAbuse, duplicateRequest, verbose, claimText, events, claimLength,
 * }
 * Emits Layer 2 histograms + one Layer 3 Loki log (plus a richer log when verbose).
 * Never logs prompts/responses/images — claimText is only present when this
 * interaction was selected for detailed tracing (see imright/scripts/verbosity.js).
 */
export function recordInteractionComplete(summary) {
  const totalTokens = summary.tokenUsage.inputTokens + summary.tokenUsage.outputTokens;
  const tags = computeAnomalyTags(summary);

  interactionCompletedCounter?.add(1, { status: summary.success ? 'success' : 'error' });
  interactionCostHistogram?.record(summary.costUsd);
  interactionTokensHistogram?.record(totalTokens);
  interactionLlmCallsHistogram?.record(summary.llm.calls);
  interactionLlmRetriesHistogram?.record(summary.llm.retries);
  interactionExternalCallsHistogram?.record(
    Object.values(summary.external ?? {}).reduce((sum, v) => sum + v.calls, 0)
  );
  interactionDurationHistogram?.record(summary.durationMs);
  for (const tag of tags) interactionTagCounter?.add(1, { tag });

  const compactRecord = {
    interaction_id: summary.interactionId,
    visitor_id: summary.visitorId,
    session_id: summary.sessionId,
    traffic_class: summary.trafficClass,
    success: summary.success,
    duration_ms: Math.round(summary.durationMs),
    llm_calls: summary.llm.calls,
    llm_failures: summary.llm.failures,
    llm_retries: summary.llm.retries,
    input_tokens: summary.tokenUsage.inputTokens,
    output_tokens: summary.tokenUsage.outputTokens,
    total_tokens: totalTokens,
    cost_usd: summary.costUsd,
    by_stage: (summary.stageRows ?? []).map((row) => ({
      stage: row.stage,
      name: row.name,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_usd: row.cost,
      time_ms: Math.round(row.timeMs),
    })),
    external: summary.external,
    claim_length: summary.claimLength,
    tags,
  };

  logStructured(summary.success ? 'info' : 'error', 'interaction_summary', compactRecord);

  // A full step/call trace is written when this interaction was pre-selected by the
  // rolling volume-based sampler (imright/scripts/verbosity.js) OR — just as often —
  // because it turned out, after the fact, to be an error or anomaly we couldn't have
  // predicted before it ran. Either way this is still exactly one extra log write.
  const shouldEmitTrace = summary.verbose || !summary.success || tags.length > 0;
  if (shouldEmitTrace) {
    logStructured(summary.success ? 'info' : 'error', 'interaction_trace', {
      interaction_id: summary.interactionId,
      claim_text: summary.claimText,
      tags,
      events: summary.events,
    });
  }
}

/** Flushes buffered logs/metrics and stops the heartbeat. Call on process shutdown. */
export async function shutdownObservability() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await Promise.all([loggerProvider?.shutdown(), meterProvider?.shutdown()].filter(Boolean));
}
