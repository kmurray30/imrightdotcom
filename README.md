We're live! Check us out at https://imright.com

## Setup

```bash
npm install
```

Requires `XAI_API_KEY` in env or `env.local`/`.env` in project root.

The whole site sits behind a password gate (`imright/scripts/auth.js`). Set `SITE_PASSWORD` in `env.local` for local dev, and as a real environment variable in Railway for prod — the server refuses to start if it's unset. Sessions are signed with a secret generated fresh per process, so restarting the server logs everyone out; that's fine for a simple gate like this.

Server logs + metrics push to Grafana Cloud (Loki + Prometheus, via OTLP) if `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` are set (Grafana Cloud → Connections → OpenTelemetry). Unset, it silently falls back to console-only. Query in Grafana Explore with `{service_name="imright"}` (logs) or the metric names below (Prometheus). `service.version` (deployed git SHA) is attached to every log/metric so a cost/retry/latency change can be correlated with a specific deploy.

### Telemetry design

Every pipeline run is one **interaction**, identified by `interaction_id` (the same value returned to the browser as `runId`), plus a persistent anonymous `visitor_id` cookie (400-day) and a sliding `session_id` cookie (30 min idle). All LLM/external-API work inside `runPipeline` attributes back to the current interaction via an `AsyncLocalStorage` context (`imright/scripts/interaction-context.js`) — no need to thread IDs through every function call. This is deliberately three layers, cheapest-first:

1. **Always-on aggregate metrics** (Prometheus, below) — low-cardinality only (`provider`, `model`, `pipeline_step`, `service`, `operation`, `status`, `traffic_class`, `tag`). Never IDs, URLs, or raw error text. Cheap forever, regardless of traffic.
2. **Per-interaction distributions** — the same cost/tokens/calls/retries/duration numbers, recorded once per completed interaction into histograms, so Grafana's `histogram_quantile` gives p50/p90/p95/p99 without needing raw data.
3. **One compact interaction-summary log per interaction** (`interaction_summary`, Loki) — the only place IDs live. No prompts, responses, or images. A richer `interaction_trace` log (per-step/per-call/per-retry timeline, plus the raw claim text) is emitted only when an interaction is sampled or turns out to be an error/anomaly — see "Detailed tracing" below. Either way it's still exactly one extra log write, never one line per call.

| Signal | Name | Fires when |
| --- | --- | --- |
| log + counter | `heartbeat` / `imright_heartbeat_total` | every 60s the server is up |
| log + counter | `page_view` / `imright_page_view_total{page="landing"\|"article"}` | landing page or an article is loaded |
| log + counter | `submit` / `imright_submit_total` | a claim is submitted (POST /api/run) |
| counter | `imright_http_requests_total{traffic_class}` | every inbound HTTP request (`page`, `api_run`, `scanner_probe`, `known_crawler`, `suspicious_api`, `blocked`) |
| counter | `imright_visitors_total{type="new"\|"returning"}` | the visitor-id cookie is read/issued |
| counter | `imright_sessions_total` | a new session-id is issued |
| counter | `imright_interaction_started_total` / `imright_interaction_completed_total{status}` | an interaction starts / finishes |
| counter | `imright_interaction_tags_total{tag}` | an anomaly tag (see below) is applied to a completed interaction |
| log + histogram | `page ready` / `imright_pipeline_time_to_ready_ms` | article page ready to view, ms since submit |
| counter + histogram | `imright_llm_calls_total{provider,model,pipeline_step,status}`, `imright_llm_latency_ms{...}` | every LLM transport attempt (including retries) |
| counter | `imright_llm_tokens_total{provider,model,pipeline_step,token_type}`, `imright_llm_cost_usd_total{...}` | a successful LLM response with usage |
| counter | `imright_retries_total{kind,pipeline_step,reason}` | any retry — `kind` is `llm_transport`, `llm_json` (unparseable model output), or `external` |
| counter + histogram | `imright_external_calls_total{service,operation,status}`, `imright_external_latency_ms{...}` | every MediaWiki/Pixabay/link-checker attempt |
| counter | `imright_external_rate_limited_total{service,operation}` | a 429 from an external dependency |
| histogram | `imright_interaction_cost_usd`, `_tokens_total`, `_llm_calls`, `_llm_retries`, `_external_calls`, `_duration_ms` | once per completed interaction — use `histogram_quantile(0.9, ...)` etc. for p50/p90/p95/p99 |

### Interaction summary (Loki)

One `interaction_summary` log per interaction: `interaction_id`, `visitor_id`, `session_id`, `traffic_class`, `success`, `duration_ms`, `llm_calls`/`llm_failures`/`llm_retries`, `input_tokens`/`output_tokens`/`total_tokens`, `cost_usd`, `by_stage` (per pipeline-step tokens/cost/time), `external` (per-service calls/failures/retries/rate-limited/timeouts), `claim_length`, and `tags`. Query it in Grafana Explore/LogQL — e.g. `{service_name="imright"} | json | cost_usd > 0.05` for expensive runs, or export a week's records to compute "% of spend from the top 5% of interactions" (a rank-based question Prometheus histograms can't answer directly).

Anomaly `tags` (thresholds in `config/telemetry_thresholds.json`, tunable without a deploy): `failed`, `high_cost`, `high_token`, `excessive_llm_calls`, `retry_heavy`, `large_input`, `large_output`, `rate_limited`, `mediawiki_rate_limited`, `image_search_rate_limited`, `suspected_abuse`, `duplicate_request`. An interaction can carry several.

### Detailed tracing

Config also holds `verbosityTiers`: the probability that an otherwise-normal interaction gets a full `interaction_trace` log (per pipeline-step and per-external-call/retry timeline, plus the raw claim text), tapered automatically by recent traffic volume — 100% under ~20 interactions/hour, down to 1% once traffic is heavy, with no restart needed to change tiers. Independent of that sample, **every** error or anomaly-tagged interaction is always traced, decided after the fact from what already accumulated during the run — nothing needed to be predicted in advance. Manual overrides (env vars, read fresh each request): `TRACE_ALL=1` (trace everything, for a short debugging window), `TRACE_VISITOR_ID=<uuid>` (always trace one visitor), `TRACE_SAMPLE_RATE=<0..1>` (override the tapered rate directly).

### Traffic classification & abuse heuristics

`imright/scripts/identity.js` classifies every request by path/UA pattern before auth even runs (so scanner noise never occupies the auth code path) and flags `/api/run` requests as `suspicious_api` when a visitor/IP exceeds the request-rate thresholds in `config/telemetry_thresholds.json`, or tags `duplicate_request` for a repeated identical claim from the same visitor within a short window. This is **visibility, not enforcement** — suspicious requests are still served, just tagged, so real telemetry-derived limits can be added deliberately later rather than accidentally blocking real users now. These counters are approximate/per-process by design (this app runs as a single Railway instance; if it's ever scaled to multiple replicas, each taper/rate-check independently — self-correcting, never explosive, without needing shared state like Redis).

### Cost accounting

Every outbound XAI/MediaWiki/Pixabay call goes through a shared wrapper (`utils/grok.js`'s `callGrok`, `utils/external-api.js`'s `callExternalApi`) that counts the attempt, classifies the outcome, and retries transient failures (timeout/429/5xx) with backoff — so "how many calls did our app make" and "how many times did we retry" are always accurate, and comparable against a provider's own dashboard to catch usage happening outside this app's expected flow.

## Run the site (landing page + pipeline)

```bash
npm run dev
# then open http://127.0.0.1:3758
```

Serves the workspace-root `index.html` landing page, accepts claims via `POST /api/run`, and streams per-stage progress over SSE (`GET /api/stream/:runId`). It drives the same `runPipeline` the CLI uses (see `imright/index.js`), so there is no pipeline logic duplication. When the tabloid HTML is ready (after stage 6) the browser redirects to `/tabloid_generator/output/<slug>.html`; stage 7 (counterarguments) finishes in the background and streams into the article via Bunky.

### Serve modes

- `npm run dev` — `local`: this machine only (`127.0.0.1`)
- `npm run dev:lan` — `lan`: reachable on your LAN (phones, other laptops)
- `npm run start:prod` — `prod`: extend `MODE_DEFAULTS` in `imright/scripts/serve-site.js` as prod behavior is added

Override without new scripts: `SERVE_MODE=<mode>`, `SERVE_HOST=<ip>`, or `PORT=<port>` inline, or stick any of them in `env.local`.

## Pipeline (run all at once from the CLI)

```bash
npm run cli -- "<claim>"
# or: node imright/cli.js "<claim>"
# or: echo "<claim>" | node imright/cli.js
```

## Other scripts

- `npm run start` — run the server with no mode set (falls back to `local`); use `npm run start:prod` for prod mode
- `npm run debug -- <slug>` — regenerate a pipeline debug page
- `npm run serve-output -- [port]` — static file server for previously-generated tabloid output

## Modules (standalone)

Order:
1. conspirator
2. wiki_searcher
3. wiki_filterer
4. ref_extractor
5. tabloid_generator

Each can be run independently or imported. The `imright` orchestrator runs all five in memory and saves outputs in parallel.
