#!/usr/bin/env node
/**
 * CLI for wiki_filterer: filters Wikipedia articles for relevance to arguments.
 *
 * Usage: node filter-wiki.js "<claim>"
 *
 * Requires: conspirator/conspiracies/<claim>.json, wiki_searcher/wikis-fetched/<claim>.yaml
 * Output: wiki_filterer/wikis-filtered/<claim>.yaml
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { filterWiki } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  for (const filename of ['env.local', '.env']) {
    const envPath = path.join(PROJECT_ROOT, filename);
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            if (!process.env[key]) process.env[key] = value;
          }
        }
      }
      break;
    }
  }
}

loadEnv();

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
    console.error('Usage: node filter-wiki.js "<claim>"');
    process.exit(1);
  }

  const slug = queryToFilename(claim);
  const conspiratorPath = path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${slug}.json`);
  const wikiPath = path.join(PROJECT_ROOT, 'wiki_searcher', 'wikis-fetched', `${slug}.yaml`);

  if (!fs.existsSync(conspiratorPath)) {
    console.error(`Conspirator file not found: ${conspiratorPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(wikiPath)) {
    console.error(`Wiki YAML not found: ${wikiPath}`);
    process.exit(1);
  }

  const conspiracy = JSON.parse(fs.readFileSync(conspiratorPath, 'utf8'));
  const wikiData = yaml.parse(fs.readFileSync(wikiPath, 'utf8'));

  const output = await filterWiki(conspiracy, wikiData);

  const outputDir = path.join(__dirname, 'wikis-filtered');
  const outputPath = path.join(outputDir, `${slug}.yaml`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, yaml.stringify(output, { lineWidth: 0 }), 'utf8');

  console.error(`Wrote ${output.page_count} articles to ${outputPath}`);
  console.log(JSON.stringify(output.pages.map((page) => ({ title: page.title, id: page.pageid })), null, 2));
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
