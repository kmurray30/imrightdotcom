# Grafana dashboards for imright

Four importable dashboards built on top of the metrics/logs `imright/scripts/observability.js` emits. This doc also lists the "bookmarked" investigative log queries — Grafana doesn't have an importable "saved query" object, so the canned queries below live as ready-made **Logs panels inside `04-weird-traffic-anomalies.json`**; this file is just a reference for pasting the same queries into Explore directly.

## Before you import: two things to verify (5 minutes)

I generated these against the metric/log names this code produces, and fixed the two issues I could identify for certain (OTel's Prometheus unit-suffix translation, and where log attributes land in Loki — see the code comments in `observability.js` for both). Everything else about the JSON/query structure I'm confident in. Two things I can't verify without your live Grafana Cloud instance:

1. **Metric names.** After your next deploy, open **Explore → your Prometheus/Mimir datasource → Metrics browser**, type `imright_` and see what autocompletes. It should match exactly what's in the table below (dots become underscores, counters get a `_total` suffix, histograms get `_bucket`/`_sum`/`_count`). If anything differs, it's a find-and-replace across the dashboard JSON files before importing.
2. **Log query form.** Run one claim through the app, then in **Explore → your Loki datasource** run `{service_name="imright"} |= `interaction_summary`` and open one result's details panel. You should see the full JSON record in the log line itself (I made this the guaranteed path — see `logStructured()` — rather than relying on how Grafana Cloud surfaces OTel log attributes as Structured Metadata, which I couldn't verify sight-unseen). If you *do* see it, every `| json` query below will work as written.

## Importing

Grafana → Dashboards → New → Import → Upload JSON file. Pick each file in `imright/observability/dashboards/`. On import, Grafana will prompt you to map `DS_PROMETHEUS` and `DS_LOKI` to your actual Grafana Cloud datasources (that's what the `${DS_...}` placeholders are for — the dashboards don't hardcode a datasource UID, since I don't have yours).

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
