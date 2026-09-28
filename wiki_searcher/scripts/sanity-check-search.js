#!/usr/bin/env node
/**
 * Quick, READ-ONLY sanity check of the paragraph-embedding index while a
 * build is still in progress. Confirms the embeddings currently in Postgres
 * are actually usable for semantic search, without touching anything the
 * build writes — every query here is a SELECT, safe to run alongside an
 * in-flight build-index-from-wikimedia.js run and its inserts (and already
 * anticipated by DB_POOL_MAX's own "+2 headroom for other occasional
 * queries" comment).
 *
 * Mocks the real query-time path (wiki_searcher/providers/wikimedia.js's
 * fetchWiki): embed a test claim with the exact same model, then run the
 * exact same vector search (utils/vectorIndex.js's searchSimilarArticles).
 * Deliberately skips the Wikimedia On-demand fetch step after that — it's a
 * live API call per article and has nothing to do with "are the embeddings
 * good" — and instead prints the ALREADY-STORED paragraph_text straight
 * from wiki_paragraph_embeddings for each match. That stored text is the
 * literal raw material downstream argument generation (wiki_filterer ->
 * ref_extractor -> tabloid_generator/counterarguer) works from, so eyeballing
 * it here is a reasonable stand-in for "does the pipeline still make sense
 * with this data" without needing to run those (LLM-backed, costly) stages
 * for a quick check.
 *
 * Usage: node wiki_searcher/scripts/sanity-check-search.js
 *   Run it from wherever DATABASE_URL is already pointed at your tunnel —
 *   the same one the build itself is using. No special setup.
 */
import { loadEnv } from '../../imright/load-env.js';
import { getPool } from '../../imright/scripts/db.js';
import { embedText } from '../textEmbeddings.js';
import { searchSimilarArticles } from '../../utils/vectorIndex.js';
import pgvector from 'pgvector/pg';

loadEnv();

// A spread of claim styles imright actually deals with — conspiratorial,
// pseudo-scientific, and a plain factual one as a control (should retrieve
// cleanly on-topic results just like the others, if anything's broken with
// the search itself rather than with conspiracy-flavored queries specifically).
const TEST_CLAIMS = [
  'the moon landing was faked by NASA',
  'vaccines cause autism',
  '5G towers spread coronavirus',
  'the earth is flat',
  'the government is hiding evidence of aliens at Area 51',
  'World War II ended in 1945', // control: unambiguous, should retrieve cleanly
];

const MATCHES_PER_CLAIM = 3;
const SNIPPET_LENGTH = 220;

async function main() {
  const pool = getPool();
  if (!pool) {
    console.error('DATABASE_URL is not set — point it at your tunnel first, same as the build script.');
    process.exit(1);
  }

  const {
    rows: [{ article_count, paragraph_count }],
  } = await pool.query('SELECT count(DISTINCT title) AS article_count, count(*) AS paragraph_count FROM wiki_paragraph_embeddings');
  console.log(`Index so far: ${article_count} distinct articles, ${paragraph_count} paragraphs embedded.\n`);

  if (Number(paragraph_count) === 0) {
    console.log('Nothing embedded yet — nothing to search. Try again once a few chunks have landed.');
    await pool.end();
    return;
  }

  for (const claim of TEST_CLAIMS) {
    console.log(`=== "${claim}" ===`);
    const embedding = await embedText(claim);
    const matches = await searchSimilarArticles(embedding, MATCHES_PER_CLAIM);

    if (matches.length === 0) {
      console.log('  (no matches — either the index is too sparse right now, or something is wrong)\n');
      continue;
    }

    for (const match of matches) {
      console.log(`  [${match.score.toFixed(3)}] ${match.title}`);
      // searchSimilarArticles only returns title+score (that's all its real
      // caller needs); pull the paragraph that actually earned this article
      // its spot, for something readable to eyeball here.
      const { rows: paragraphRows } = await pool.query(
        `SELECT section, paragraph_text FROM wiki_paragraph_embeddings WHERE title = $1 ORDER BY embedding <=> $2 LIMIT 1`,
        [match.title, pgvector.toSql(embedding)]
      );
      const paragraph = paragraphRows[0];
      if (paragraph) {
        const text = paragraph.paragraph_text.replace(/\s+/g, ' ').trim();
        const snippet = text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text;
        console.log(`      (${paragraph.section}) "${snippet}"`);
      }
    }
    console.log('');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
