#!/usr/bin/env node
/**
 * One-time full build: streams a decompressed Wikimedia Enterprise Snapshot
 * NDJSON file (one article JSON object per line — see
 * https://enterprise.wikimedia.com/docs/snapshot/) and embeds+upserts every
 * article's paragraphs into wiki_paragraph_embeddings.
 *
 * You need to download and extract the snapshot yourself first:
 *   curl -H "Authorization: Bearer $ACCESS_TOKEN" -L \
 *     https://api.enterprise.wikimedia.com/v2/snapshots/enwiki_namespace_0/download \
 *     --output enwiki.tar.gz
 *   tar xzf enwiki.tar.gz
 * (Consider downloading by chunk instead — see the Snapshot API docs — enwiki
 * is large; this script doesn't care, it just reads whatever NDJSON path you give it.)
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
  let totalArticles = 0;
  let totalParagraphs = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    chunk.push(line);
    if (chunk.length >= CHUNK_SIZE) {
      totalParagraphs += await processChunk(chunk);
      totalArticles += chunk.length;
      chunk = [];
    }
  }
  if (chunk.length > 0) {
    totalParagraphs += await processChunk(chunk);
    totalArticles += chunk.length;
  }

  console.log(`\nDone. Indexed ${totalArticles} articles, ${totalParagraphs} paragraphs.`);
}

async function processChunk(lines) {
  let paragraphCount = 0;
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
      paragraphCount += result.paragraphCount;
    },
    CONCURRENCY
  );
  return paragraphCount;
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
