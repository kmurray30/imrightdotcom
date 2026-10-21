#!/usr/bin/env node
/**
 * Streams an already-decompressed Wikimedia Enterprise Snapshot NDJSON file
 * (one article JSON object per line — see
 * https://enterprise.wikimedia.com/docs/snapshot/) and embeds+upserts every
 * article's cited spans into wiki_citation_spans (see embeddingIndex.js).
 *
 * For the primary workflow — downloading the snapshot from Wikimedia and
 * building the index from it — use build-index-from-wikimedia.js instead.
 * That script handles download, extraction, and embedding chunk-by-chunk on
 * its own, so the full corpus is never materialized on disk at once (it's
 * 1TB+ uncompressed) and there's no separate build step to run afterward.
 *
 * This script is for the narrower case where you already have a decompressed
 * NDJSON file from somewhere else (a manual download, a subset export, etc.)
 * and just want it embedded.
 *
 * Usage: node wiki_searcher/scripts/build-index-from-ndjson.js /path/to/enwiki_namespace_0.ndjson
 */
import fs from 'fs';
import readline from 'readline';
import { loadEnv } from '../../imright/load-env.js';
import { upsertSpansBatch, ensureSpansTable, SPANS_TABLE, UNEMBEDDED_TABLE } from '../embeddingIndex.js';

loadEnv();

const ndjsonPath = process.argv[2];
if (!ndjsonPath) {
  console.error('Usage: node wiki_searcher/scripts/build-index-from-ndjson.js /path/to/snapshot.ndjson');
  process.exit(1);
}

// Articles per upsertSpansBatch call: one embedding call and one transaction
// per batch. Batches run one after another — the local embedding model is
// the bottleneck and gains nothing from concurrent callers, and sequential
// batches let the in-batch version check (newest copy of a title wins) hold
// across the whole file.
const BATCH_SIZE = 50;
const PROGRESS_EVERY = 500;

async function main() {
  await ensureSpansTable();
  console.log(`Writing cited spans from ${ndjsonPath} to ${SPANS_TABLE}`);
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });

  const totals = { lines: 0, malformed: 0, noBody: 0, articles: 0, alreadyCurrent: 0, spans: 0, unembedded: 0 };
  const timings = { readMs: 0, embedMs: 0, writeMs: 0 };
  let nextProgress = PROGRESS_EVERY;
  let batch = [];

  async function flush() {
    if (batch.length === 0) return;
    const results = await upsertSpansBatch(batch, timings);
    batch = [];
    for (const result of results) {
      totals.articles++;
      totals.spans += result.spanCount;
      totals.unembedded += result.unembeddedCount ?? 0;
      if (result.skipped) totals.alreadyCurrent++;
    }
    if (totals.articles >= nextProgress) {
      nextProgress += PROGRESS_EVERY;
      console.log(`  ...${totals.articles} articles processed (${totals.spans} spans embedded, ${totals.unembedded} stored unembedded, ${totals.alreadyCurrent} already current)`);
    }
  }

  for await (const line of rl) {
    if (!line.trim()) continue;
    totals.lines++;
    let article;
    try {
      article = JSON.parse(line);
    } catch {
      totals.malformed++; // skip malformed lines rather than aborting the whole build
      continue;
    }
    const html = article.article_body?.html;
    if (!html) {
      totals.noBody++; // deleted/visibility-changed/empty articles omit article_body
      continue;
    }
    batch.push({
      title: article.name,
      html,
      versionIdentifier: article.version?.identifier,
      pageId: article.identifier,
    });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  console.log(
    `\nDone. ${totals.lines} lines: ${totals.articles} articles (${totals.alreadyCurrent} already current, skipped), ` +
      `${totals.noBody} without article_body, ${totals.malformed} malformed. ${totals.spans} spans embedded into ${SPANS_TABLE}, ${totals.unembedded} stored in ${UNEMBEDDED_TABLE}. ` +
      `Time: read ${seconds(timings.readMs)}, embed ${seconds(timings.embedMs)}, write ${seconds(timings.writeMs)}.`
  );
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
