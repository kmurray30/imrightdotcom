#!/usr/bin/env node
/**
 * Applies schema.sql to whatever DATABASE_URL points at.
 * Usage: npm run migrate
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../load-env.js';
import { query } from './db.js';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schemaSql);
  console.log('Migration applied: "pages" table is ready.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
