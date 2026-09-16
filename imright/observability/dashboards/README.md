# Grafana dashboards for imright

Four importable dashboards built on top of the metrics/logs `imright/scripts/observability.js` emits. This doc also lists the "bookmarked" investigative log queries — Grafana doesn't have an importable "saved query" object, so the canned queries below live as ready-made **Logs panels inside `04-weird-traffic-anomalies.json`**; this file is just a reference for pasting the same queries into Explore directly.

## Schema

These are written in Grafana's newer `dashboard.grafana.app/v2` kind format (elements/layout/vizConfig), not the older flat `schemaVersion` format — matched to a real export from this Grafana Cloud instance. The outer envelope (`apiVersion`/`kind`/`metadata`/`spec`, `elements`, `GridLayout`/`GridLayoutItem` with `width`/`height`, `PanelQuery`/`DataQuery` with `datasource: {name}`) is verified against [grafana/grafana's own CUE schema source](https://github.com/grafana/grafana/blob/main/apps/dashboard/kinds/v2/dashboard_spec.cue) plus the real dashboard JSON that was pasted back to me — and 01/02/03 imported clean. Each panel's `vizConfig.spec.fieldConfig`/`options` internals are unchanged from a first draft written against the older schema — those belong to each panel plugin (stat, timeseries, table, ...) and are schema-version-agnostic, so v1↔v2 didn't touch them.

**Known gotcha, already worked around:** the CUE source above is Grafana's `main` development branch, which doesn't necessarily match what's deployed on any given Grafana Cloud instance. It defines a `TextVariableKind` (`"kind": "TextVariable"`) for a plain textbox variable, but this instance's actual schema rejected it — its `variables` disjunction only accepts `AdhocVariable`, `ConstantVariable`, `CustomVariable`, `DatasourceVariable`, `GroupByVariable`, `IntervalVariable`, `QueryVariable`, `SwitchVariable`, no text-box equivalent among them. Rather than guess at another unverified name, `04-weird-traffic-anomalies.json` now ships with `variables: []` and its "trace one interaction" panel is a hand-editable template (swap `REPLACE_WITH_INTERACTION_ID` in the query for a real one) instead of a live dashboard variable. If a real interactive variable matters later, the reliable way to get the right kind name is to create one manually in the UI (Dashboard settings → Variables → New) and read it back off the JSON model, rather than trust an external schema source again.

Both things flagged in an earlier draft of this doc as unverified are now resolved: dashboard 01 has a Loki-backed table panel (the "top visitors" one) using this same `expr`/`queryType`/`resultFormat` shape and the `grafanacloud-logs` name, and it imported clean — so both the Loki datasource name and the Loki `DataQuery.spec` field shape are confirmed correct at the schema level. What's still worth eyeballing once real interaction data exists: whether that panel's query actually *renders* sensibly (schema validation only confirms the shape is accepted, not that the query is semantically ideal for a table visualization).

Also worth a glance: `vizConfig.version` is set to `"13.3.0-34259522365"` on every panel — the exact string from your barchart example. Core panel types (stat/timeseries/table/logs/text/bargauge/piechart) ship as part of Grafana core, so they should all share your instance's build version, but this field is almost certainly non-blocking metadata (like classic schema's `pluginVersion`) rather than something Grafana validates strictly on save — consistent with 01/02/03 having imported fine despite being a guess.

## Metric names — still worth verifying (5 minutes)

I generated the queries against the metric/log names this code produces, and fixed the two issues I could identify for certain (OTel's Prometheus unit-suffix translation, and where log attributes land in Loki — see the code comments in `observability.js` for both). One thing left that I can't verify without your live instance:

**Metric names.** After your next deploy, open **Explore → your Prometheus/Mimir datasource → Metrics browser**, type `imright_` and see what autocompletes. It should match exactly what's in the table below (dots become underscores, counters get a `_total` suffix, histograms get `_bucket`/`_sum`/`_count`). If anything differs, it's a find-and-replace across the dashboard JSON files.

**Log query form.** Run one claim through the app, then in **Explore → your Loki datasource** run `{service_name="imright"} |= `interaction_summary`` and open one result's details panel. You should see the full JSON record in the log line itself (the guaranteed path — see `logStructured()` — rather than relying on how Grafana Cloud surfaces OTel log attributes as Structured Metadata). If you *do* see it, every `| json` query below will work as written.

## Importing

This `apiVersion`/`kind`/`metadata`/`spec` envelope is the API/provisioning-native resource format, not necessarily what the classic **Dashboards → New → Import → Upload JSON** screen expects (that flow historically wants the bare classic dashboard object, no envelope). I don't have hands-on access to your instance to confirm which of these actually accepts it — try, in order:

1. **Dashboards → New → Import → Upload JSON file** — if your Grafana version's import flow auto-detects the v2 envelope, this just works.
2. Create a blank dashboard, open its **Settings → JSON Model** editor, and paste the file's content in directly.
3. If you provision dashboards as code / via API or a `kubectl`-style workflow, this is exactly the resource shape that path expects.

If (1) rejects the file outright, that's the signal to fall back to (2).

| File | Dashboard |
| --- | --- |
| `01-product-traffic.json` | Product & Traffic — visitors, sessions, interactions, traffic classification |
| `02-cost-llm.json` | Cost & LLM — spend, tokens, calls, p50/p90/p95/p99, cost by pipeline step/model, retries |
| `03-pipeline-external-apis.json` | Pipeline & External APIs — MediaWiki/Pixabay/link-checker health, latency, rate limits |
| `04-weird-traffic-anomalies.json` | Weird Traffic & Anomalies — anomaly tag breakdown + all bookmarked log queries |

## Bookmarked LogQL queries (Explore-ready)

All against the Loki datasource, all also live as Logs panels on dashboard 4.

| Answers | Query |
| --- | --- |
| **All errors, any source** (broadest safety net) | `{service_name="imright"} \| detected_level="error"` |
| Warnings (rate-limits etc., not failures) | `{service_name="imright"} \| detected_level="warn"` |
| Failed interactions | `{service_name="imright"} \|= \`interaction_summary\` \| json \| success=\`false\`` |
| Interactions costing more than $0.05 | `{service_name="imright"} \|= \`interaction_summary\` \| json \| cost_usd > 0.05` |
| Interactions with more than 8 LLM calls | `{service_name="imright"} \|= \`interaction_summary\` \| json \| llm_calls > 8` |
| Retry-heavy interactions (3+ retries) | `{service_name="imright"} \|= \`interaction_summary\` \| json \| llm_retries >= 3` |
| Any rate-limited external dependency | `{service_name="imright"} \|= \`interaction_summary\` \|= \`rate_limited\`` |
| Suspected abuse | `{service_name="imright"} \|= \`interaction_summary\` \|= \`suspected_abuse\`` |
| Duplicate/repeated requests | `{service_name="imright"} \|= \`interaction_summary\` \|= \`duplicate_request\`` |
| Full trace for one interaction | `{service_name="imright"} \|= "<interaction_id>"` |
| Costs by visitor (needs `| json`'s extracted `visitor_id` field) | `{service_name="imright"} \|= \`interaction_summary\` \| json \| visitor_id="<visitor_id>"` |

Note the `rate_limited`/`suspected_abuse`/`duplicate_request` queries use a plain substring match (`\|=`) rather than `\| json \| tags=~...` — `tags` is a JSON array, and Loki's array handling through `| json` is inconsistent enough that matching the raw JSON text (which `logStructured()` guarantees contains the tag name) is the safer bet.

`detected_level` is Loki's own severity-derived label (populated from the OTel `severityNumber`/`severityText` every log call sets) and is the simplest way to catch *everything* logged at a given severity, structured or plain — but it has documented edge cases specifically for OTLP-sourced severity. As a guaranteed fallback for structured logs specifically, `logStructured()` also puts `level` directly in the JSON body, so `{service_name="imright"} | json | level="error"` works even if `detected_level` ever misbehaves. Plain `log()` calls (heartbeat, page views, submits) have no such fallback — they're not JSON, so `detected_level` is the only lever there, which is fine since none of those are ever error-severity in practice.

### "What % of spend comes from the top 1% / 5% / 10% of interactions?"

Not a single query — Prometheus/LogQL histograms give you distribution shape, not a rank-weighted sum. Three-query recipe per cutoff (repeat with `0.99`/`0.95`/`0.90` for top 1%/5%/10%):

1. Find the cost threshold: `quantile_over_time(0.99, {service_name="imright"} |= `interaction_summary` | json | unwrap cost_usd [$__range])`
2. Total spend in the range: `sum(sum_over_time({service_name="imright"} |= `interaction_summary` | json | unwrap cost_usd [$__range]))`
3. Spend from interactions at/above the threshold from step 1 (paste the number in): `sum(sum_over_time({service_name="imright"} |= `interaction_summary` | json | cost_usd >= 0.0842 | unwrap cost_usd [$__range]))`

Divide (3) by (2). For an exact answer instead of a Loki-side approximation, it's just as easy to export a week of `interaction_summary` logs and sum in a spreadsheet/script — there's no bulky content in these records, so a week's worth is small.

## Metric reference (post the unit-suffix fix)

Counters (`_total` suffix from OTel's monotonic-sum convention):
`imright_heartbeat_total`, `imright_page_view_total{page}`, `imright_submit_total`, `imright_http_requests_total{traffic_class}`, `imright_visitors_total{type}`, `imright_sessions_total`, `imright_interaction_started_total`, `imright_interaction_completed_total{status}`, `imright_interaction_tags_total{tag}`, `imright_llm_calls_total{provider,model,pipeline_step,status}`, `imright_llm_tokens_total{provider,model,pipeline_step,token_type}`, `imright_llm_cost_usd_total{provider,model,pipeline_step}`, `imright_external_calls_total{service,operation,status}`, `imright_external_rate_limited_total{service,operation}`, `imright_retries_total{kind,pipeline_step,reason}`.

Histograms (`_bucket{le,...}` / `_sum` / `_count`): `imright_pipeline_time_to_ready_ms`, `imright_llm_latency_ms{provider,model,pipeline_step}`, `imright_external_latency_ms{service,operation}`, `imright_interaction_cost_usd`, `imright_interaction_tokens_total`, `imright_interaction_llm_calls`, `imright_interaction_llm_retries`, `imright_interaction_external_calls`, `imright_interaction_duration_ms`.

Bucket boundaries were hand-picked for this app's actual value ranges (see `MS_BUCKETS_SHORT`/`MS_BUCKETS_EXTERNAL` and the per-histogram `advice.explicitBucketBoundaries` in `observability.js`) rather than left at the SDK default — the default buckets (0,5,10,25,50,75,100,...) would have dumped nearly every cost/call-count value into the first bucket, making `histogram_quantile` meaningless. If real traffic ends up concentrated in one bucket anyway, widen/narrow that histogram's boundaries and redeploy — old data stays queryable, it just has coarser resolution before the change.
