We're live! Check us out at https://imright.com

## Setup

```bash
npm install
```

Requires `XAI_API_KEY` in env or `env.local`/`.env` in project root.

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
