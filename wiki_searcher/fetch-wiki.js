#!/usr/bin/env node
/**
 * CLI for wiki_searcher: fetches Wikipedia data via MediaWiki API.
 *
 * Usage: node fetch-wiki.js "<claim>"
 *
 * Requires: conspirator/conspiracies/<claim>.yaml
 * Output: wiki_searcher/wikis-fetched/<claim>.yaml
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { fetchWiki } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Convert query to a safe filename: lowercase, spaces to hyphens, strip non-alphanumeric. */
function queryToFilename(query) {
  return query
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'untitled';
}

async function main() {
  const claim = process.argv.slice(2).join(' ').trim();
  if (!claim) {
    console.error('Usage: node fetch-wiki.js "<claim>"');
    process.exit(1);
  }

  const conspiratorPath = path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${queryToFilename(claim)}.yaml`);

  if (!fs.existsSync(conspiratorPath)) {
    console.error(`Conspirator file not found: ${conspiratorPath}`);
    process.exit(1);
  }

  const conspiracy = yaml.parse(fs.readFileSync(conspiratorPath, 'utf8'));
  const output = await fetchWiki(conspiracy);

  const outputPath = path.join(__dirname, 'wikis-fetched', `${queryToFilename(claim)}.yaml`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.stringify(output, { lineWidth: 0 }), 'utf8');

  console.log(`Done. Wrote ${output.page_count} articles to ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
