#!/usr/bin/env node
/**
 * Streams an already-decompressed Wikimedia Enterprise Snapshot NDJSON file
 * (one article JSON object per line — see
 * https://enterprise.wikimedia.com/docs/snapshot/) and embeds+upserts every
 * article's paragraphs into wiki_paragraph_embeddings.
 *
 * For the primary workflow — downloading the snapshot from Wikimedia and
 * building the index from it — use download-snapshot.js instead. That script
 * handles download, extraction, and embedding chunk-by-chunk on its own, so
 * the full corpus is never materialized on disk at once (it's 1TB+
 * uncompressed) and there's no separate build step to run afterward.
 *
 * This script is for the narrower case where you already have a decompressed
 * NDJSON file from somewhere else (a manual download, a subset export, etc.)
 * and just want it embedded.
 *
 * Usage: node wiki_searcher/scripts/build-index-from-snapshot.js /path/to/enwiki_namespace_0.ndjson
 */
import fs from 'fs';
import readline from 'readline';
import { loadEnv } from '../../imright/load-env.js';
import { upsertArticleEmbeddings } from '../embeddingIndex.js';

loadEnv();

const ndjsonPath = process.argv[2];
if (!ndjsonPath) {
  console.error('Usage: node wiki_searcher/scripts/build-index-from-snapshot.js /path/to/snapshot.ndjson');
  process.exit(1);
}

const CONCURRENCY = 4; // local embedding model is CPU-bound; tune to your box's core count

async function processInBatches(lines, worker, concurrency) {
  let cursor = 0;
  let processed = 0;
  async function runNext() {
    while (cursor < lines.length) {
      const index = cursor++;
      await worker(lines[index]);
      processed++;
      if (processed % 500 === 0) console.log(`  ...${processed} articles indexed`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runNext));
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });

  // Buffer in reasonably sized chunks so we're not holding the whole file in
  // memory, but still get useful concurrency within each chunk.
  const CHUNK_SIZE = 2000;
  let chunk = [];
  const totals = { articles: 0, paragraphs: 0, alreadyCurrent: 0 };

  for await (const line of rl) {
    if (!line.trim()) continue;
    chunk.push(line);
    if (chunk.length >= CHUNK_SIZE) {
      await processChunk(chunk, totals);
      chunk = [];
    }
  }
  if (chunk.length > 0) {
    await processChunk(chunk, totals);
  }

  console.log(
    `\nDone. Indexed ${totals.articles} articles (${totals.alreadyCurrent} already current, skipped), ${totals.paragraphs} paragraphs.`
  );
}

async function processChunk(lines, totals) {
  await processInBatches(
    lines,
    async (line) => {
      let article;
      try {
        article = JSON.parse(line);
      } catch {
        return; // skip malformed lines rather than aborting the whole build
      }
      const wikitext = article.article_body?.wikitext;
      if (!wikitext) return; // deleted/visibility-changed/empty articles omit article_body
      const result = await upsertArticleEmbeddings({
        title: article.name,
        wikitext,
        versionIdentifier: article.version?.identifier,
      });
      totals.articles++;
      totals.paragraphs += result.paragraphCount;
      if (result.skipped) totals.alreadyCurrent++;
      if (totals.articles % 500 === 0) {
        console.log(`  ...${totals.articles} articles processed (${totals.paragraphs} paragraphs, ${totals.alreadyCurrent} already current)`);
      }
    },
    CONCURRENCY
  );
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
