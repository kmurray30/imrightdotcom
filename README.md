We're live! Check us out at https://imright.com

## Setup

```bash
npm install
```

Requires `XAI_API_KEY` in env or `env.local`/`.env` in project root.

The whole site sits behind a password gate (`imright/scripts/auth.js`). Set `SITE_PASSWORD` in `env.local` for local dev, and as a real environment variable in Railway for prod — the server refuses to start if it's unset. Sessions are signed with a secret generated fresh per process, so restarting the server logs everyone out; that's fine for a simple gate like this.

Server logs + metrics push to Grafana Cloud (Loki + Prometheus, via OTLP) if `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` are set (Grafana Cloud → Connections → OpenTelemetry). Bare-bones for now (`imright/scripts/observability.js`); unset, it silently falls back to console-only. Query in Grafana Explore with `{service_name="imright"}` (logs) or the metric names below (Prometheus):

| Signal | Name | Fires when |
| --- | --- | --- |
| log + counter | `heartbeat` / `imright_heartbeat_total` | every 60s the server is up |
| log + counter | `page_view` / `imright_page_view_total{page="landing"\|"article"}` | landing page or an article is loaded |
| log + counter | `submit` / `imright_submit_total` | a claim is submitted (POST /api/run) |
| log + histogram | `page ready` / `imright_pipeline_time_to_ready_ms` | article page is ready to view, ms since submit |
| log + counter | `pipeline run success\|error` / `imright_pipeline_runs_total{status=...}` | a pipeline run finishes |
| log + histogram | `pipeline cost` / `imright_pipeline_cost_usd` | estimated LLM cost (USD) of a completed run |

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
