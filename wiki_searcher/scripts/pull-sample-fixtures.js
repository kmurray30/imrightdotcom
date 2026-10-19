#!/usr/bin/env node
/**
 * Turns the raw article records that sample-article-structure.js stored in
 * Postgres (--fixtures-to-db, when run on Railway) into the unit-test fixture
 * file wiki_searcher/__tests__/fixtures/enterprise-sample.ndjson. Run from the
 * repo with DATABASE_URL pointed at the database (e.g. through the db tunnel),
 * then commit the file.
 *
 * Usage: node wiki_searcher/scripts/pull-sample-fixtures.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../../imright/load-env.js';

loadEnv();
const { getPool } = await import('../../imright/scripts/db.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '__tests__', 'fixtures', 'enterprise-sample.ndjson');

const pool = getPool();
if (!pool) {
  console.error('DATABASE_URL is not set — point it at the database (e.g. via the db tunnel) first.');
  process.exit(1);
}
try {
  const { rows } = await pool.query('SELECT name, record FROM wiki_sample_fixtures ORDER BY id');
  if (rows.length === 0) {
    console.log('wiki_sample_fixtures is empty — run sample-article-structure.js with --fixtures-to-db first.');
  } else {
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, rows.map((r) => JSON.stringify(r.record)).join('\n') + '\n');
    console.log(`Wrote ${rows.length} records (${rows.map((r) => r.name).join(', ')}) to ${path.relative(process.cwd(), FIXTURE_PATH)} — commit it; npm run test:unit now covers real articles.`);
  }
} finally {
  await pool.end();
}
