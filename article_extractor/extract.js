#!/usr/bin/env node
/**
 * Extracts relevant citations from filtered wiki articles.
 * Filters by citation type whitelist, link presence, and minisearch relevance.
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
import MiniSearch from 'minisearch';
import { parseRefs } from './parser/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

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

  const filename = `${queryToFilename(claim)}`;
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

  const configPath = path.join(__dirname, 'config.yaml');
  const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
  const priorSentences = config.prior_sentences ?? 1;
  const citationTypes = new Set((config.citation_types ?? []).map((t) => t.toLowerCase()));

  const conspiratorData = JSON.parse(fs.readFileSync(conspiratorPath, 'utf8'));
  const wikiData = yaml.parse(fs.readFileSync(wikiPath, 'utf8'));
  const pages = wikiData?.pages ?? [];

  const searchTerms = [conspiratorData.topic ?? claim];
  for (const angle of conspiratorData.angles ?? []) {
    if (angle.argument) searchTerms.push(angle.argument);
    for (const query of angle.search_queries ?? []) {
      if (query) searchTerms.push(query);
    }
  }

  const allCitations = [];
  for (const page of pages) {
    const source = page.source ?? '';
    const title = page.title ?? 'Unknown';
    const refs = parseRefs(source, title, priorSentences, null);
    allCitations.push(...refs);
  }

  console.error(`Citations extracted: ${allCitations.length}`);

  const withLink = allCitations.filter(
    (c) =>
      c.link &&
      c.link.startsWith('http') &&
      citationTypes.has(c.type)
  );
  console.error(`After whitelist+link filter: ${withLink.length}`);

  const searchIndex = new MiniSearch({
    fields: ['blurb', 'sentence'],
    storeFields: ['blurb', 'sentence', 'link', 'article_title', 'section'],
    searchOptions: { combineWith: 'OR', fuzzy: 0.2 },
  });

  withLink.forEach((citation, index) => {
    searchIndex.add({ id: String(index), ...citation });
  });

  const matchedIds = new Set();
  for (const term of searchTerms) {
    if (!term || term.length < 2) continue;
    const results = searchIndex.search(term, { limit: 1000 });
    for (const result of results) {
      matchedIds.add(result.id);
    }
  }

  const filtered = withLink.filter((_, index) => matchedIds.has(String(index)));
  console.error(`After minisearch filter: ${filtered.length}`);

  const byArticle = {};
  for (const citation of filtered) {
    const articleTitle = citation.article_title;
    const section = citation.section;
    if (!byArticle[articleTitle]) byArticle[articleTitle] = {};
    if (!byArticle[articleTitle][section]) byArticle[articleTitle][section] = [];
    byArticle[articleTitle][section].push({
      link: citation.link,
      blurb: citation.blurb,
      sentence: citation.sentence,
    });
  }

  const outputPath = path.join(__dirname, 'extracted', `${filename}.yaml`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.stringify(byArticle, { lineWidth: 0 }), 'utf8');

  console.error(`Wrote to ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
