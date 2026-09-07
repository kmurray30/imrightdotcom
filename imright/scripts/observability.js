/**
 * Bare-bones Grafana Cloud observability via OTLP -> Loki (logs) + Prometheus (metrics).
 * Sends a startup log, a periodic heartbeat log, and a heartbeat counter metric
 * so the connection can be validated in Grafana Explore; call log()/recordHeartbeat-
 * style helpers elsewhere as real events are added later. If
 * OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS aren't set, this is a no-op and log() just
 * goes to the console.
 */

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SeverityNumber } from '@opentelemetry/api-logs';

// Without this, failed OTLP exports (bad auth, network errors, etc.) are silently
// swallowed by the SDK instead of showing up anywhere.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const SERVICE_NAME = 'imright';
const HEARTBEAT_INTERVAL_MS = 60_000;

let loggerProvider = null;
let otelLogger = null;
let meterProvider = null;
let heartbeatCounter = null;
let heartbeatTimer = null;
let pageViewCounter = null;
let submitCounter = null;
let runResultCounter = null;
let timeToReadyHistogram = null;
let costHistogram = null;

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
      processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: logsUrl, headers }) })],
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
          exporter: new OTLPMetricExporter({ url: metricsUrl, headers }),
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
    runResultCounter = meter.createCounter('imright.pipeline.runs', {
      description: 'Completed pipeline runs, labeled by outcome (success, error).',
    });
    timeToReadyHistogram = meter.createHistogram('imright.pipeline.time_to_ready_ms', {
      description: 'Time from submit to the article page being ready to view.',
      unit: 'ms',
    });
    costHistogram = meter.createHistogram('imright.pipeline.cost_usd', {
      description: 'Estimated LLM cost per completed pipeline run.',
      unit: 'USD',
    });
  } catch (setupError) {
    console.error(`[observability] failed to set up Grafana metrics; continuing without metrics: ${setupError.message}`);
    meterProvider = null;
    heartbeatCounter = null;
    pageViewCounter = null;
    submitCounter = null;
    runResultCounter = null;
    timeToReadyHistogram = null;
    costHistogram = null;
  }

  console.error(
    `[observability] Grafana logging=${otelLogger ? 'enabled' : 'disabled'}, metrics=${heartbeatCounter ? 'enabled' : 'disabled'} (service.name=${SERVICE_NAME})`
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

/** Call once a pipeline run finishes, success or failure. */
export function recordRunResult(status, slug, attributes = {}) {
  log(status === 'success' ? 'info' : 'error', `pipeline run ${status}`, { slug, status, ...attributes });
  runResultCounter?.add(1, { status });
}

/** Call when the article page becomes ready to view, with ms elapsed since submit. */
export function recordTimeToReady(ms, slug) {
  log('info', 'page ready', { slug, timeMs: Math.round(ms) });
  timeToReadyHistogram?.record(ms);
}

/** Call with the estimated LLM cost (USD) of a completed pipeline run. */
export function recordCost(usd, slug) {
  log('info', 'pipeline cost', { slug, costUsd: usd });
  costHistogram?.record(usd);
}

/** Flushes buffered logs/metrics and stops the heartbeat. Call on process shutdown. */
export async function shutdownObservability() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await Promise.all([loggerProvider?.shutdown(), meterProvider?.shutdown()].filter(Boolean));
}
