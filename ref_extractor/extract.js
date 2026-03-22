#!/usr/bin/env node
/**
 * CLI for ref_extractor: extracts relevant citations from filtered wiki articles.
 *
 * Usage: node extract.js "<claim>"
 *        node extract.js "<claim>" --no-check-links   # skip HEAD link validation (faster)
 *
 * Requires: conspirator/conspiracies/<claim>.yaml, wiki_filterer/wikis-filtered/<claim>.yaml
 * Output: ref_extractor/extracted/<claim>.yaml
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
  const args = process.argv.slice(2);
  const noCheckLinks = args.includes('--no-check-links');
  const claim = args.filter((arg) => arg !== '--no-check-links').join(' ').trim();
  if (!claim) {
    console.error('Usage: node extract.js "<claim>"');
    process.exit(1);
  }

  const filename = queryToFilename(claim);
  const conspiratorPath = path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${filename}.yaml`);
  const wikiPath = path.join(PROJECT_ROOT, 'wiki_filterer', 'wikis-filtered', `${filename}.yaml`);

  if (!fs.existsSync(conspiratorPath)) {
    console.error(`Conspirator file not found: ${conspiratorPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(wikiPath)) {
    console.error(`Wiki filtered file not found: ${wikiPath}`);
    process.exit(1);
  }

  const conspiratorData = yaml.parse(fs.readFileSync(conspiratorPath, 'utf8'));
  const wikiData = yaml.parse(fs.readFileSync(wikiPath, 'utf8'));

  const { extracted: byArticle, stats } = await extract(conspiratorData, wikiData, {
    check_links: !noCheckLinks,
    slug: filename,
  });

  const refCount = Object.values(byArticle).reduce(
    (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
    0
  );
  const uniqueCount = new Set(
    Object.values(byArticle).flatMap((items) =>
      Array.isArray(items) ? items.map((item) => item.link + '|' + item.title) : []
    )
  ).size;

  const outputPath = path.join(__dirname, 'extracted', `${filename}.yaml`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.stringify(byArticle, { lineWidth: 0 }), 'utf8');

  let logLine = `Wrote to ${outputPath} (${refCount} refs, ${uniqueCount} unique citations)`;
  if (!noCheckLinks && stats?.linkStats) {
    const { retries, deadLinksCount, deadLinks } = stats.linkStats;
    logLine += ` [retries: ${retries}, dead links: ${deadLinksCount}]`;
    if (deadLinks?.length > 0) {
      console.error('Dead links:');
      for (const { url, reason } of deadLinks) {
        console.error(`  ${url} — ${reason}`);
      }
    }
  }
  console.error(logLine);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
