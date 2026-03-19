#!/usr/bin/env node
/**
 * CLI for article_extractor: extracts relevant citations from filtered wiki articles.
 *
 * Usage: node extract.js "<claim>"
 *
 * Requires: conspirator/conspiracies/<claim>.json, wiki_filterer/wikis-filtered/<claim>.yaml
 * Output: article_extractor/extracted/<claim>.yaml
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { extract } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Normalize a claim string into a filename-safe slug. */
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
    console.error('Usage: node extract.js "<claim>"');
    process.exit(1);
  }

  const filename = queryToFilename(claim);
  const conspiratorPath = path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${filename}.json`);
  const wikiPath = path.join(PROJECT_ROOT, 'wiki_filterer', 'wikis-filtered', `${filename}.yaml`);

  if (!fs.existsSync(conspiratorPath)) {
    console.error(`Conspirator file not found: ${conspiratorPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(wikiPath)) {
    console.error(`Wiki filtered file not found: ${wikiPath}`);
    process.exit(1);
  }

  const conspiratorData = JSON.parse(fs.readFileSync(conspiratorPath, 'utf8'));
  const wikiData = yaml.parse(fs.readFileSync(wikiPath, 'utf8'));

  const byArticle = await extract(conspiratorData, wikiData);

  const refCount = Object.values(byArticle).reduce(
    (sum, sections) => sum + Object.values(sections).reduce((s, items) => s + items.length, 0),
    0
  );
  const uniqueCount = new Set(
    Object.values(byArticle).flatMap((sections) =>
      Object.values(sections).flatMap((items) => items.map((item) => item.link + '|' + item.blurb))
    )
  ).size;

  const outputPath = path.join(__dirname, 'extracted', `${filename}.yaml`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.stringify(byArticle, { lineWidth: 0 }), 'utf8');

  console.error(`Wrote to ${outputPath} (${refCount} refs, ${uniqueCount} unique citations)`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
