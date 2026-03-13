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

// ESM modules don't have __dirname by default; derive it from import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Key for deduping citations (refs = each in-text reference; citations = unique sources).
 * Use both link and blurb when available; otherwise whichever is present.
 */
function uniqueCitationKey(citation) {
  if (citation.link && citation.blurb) {
    return citation.link + '|' + citation.blurb;
  }
  return citation.link || citation.blurb || 'no-link-' + citation.type;
}

/**
 * Normalize a claim string into a filename-safe slug (e.g. "Foo Bar!" -> "foo-bar").
 */
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
  // argv[0]=node, argv[1]=script; rest is our claim
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

  // Load config; ?? is nullish coalescing (use right side if left is null/undefined)
  const configPath = path.join(__dirname, 'config.yaml');
  const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
  const priorSentences = config.prior_sentences ?? 1;
  const citationTypes = new Set((config.citation_types ?? []).map((t) => t.toLowerCase()));
  const excludeUrlPatterns = (config.exclude_url_patterns ?? []).map((p) => p.toLowerCase());
  const minTermsMatched = config.min_terms_matched ?? 2;
  const minTermLength = config.min_term_length ?? 5;
  const minisearchFuzzy = config.minisearch_fuzzy ?? 0;
  const topk = config.topk ?? 50;
  const rrfK = config.rrf_k ?? 60;

  const conspiratorData = JSON.parse(fs.readFileSync(conspiratorPath, 'utf8'));
  const wikiData = yaml.parse(fs.readFileSync(wikiPath, 'utf8'));
  const pages = wikiData?.pages ?? [];  // ?. = optional chaining (no error if pages missing)

  // Build search terms from topic + all angle arguments and search_queries
  const searchTerms = [conspiratorData.topic ?? claim];
  for (const angle of conspiratorData.angles ?? []) {
    if (angle.argument) searchTerms.push(angle.argument);
    for (const query of angle.search_queries ?? []) {
      if (query) searchTerms.push(query);
    }
  }

  // --- Step 1: Parse all wiki pages and extract citations ---
  const allCitations = [];
  for (const page of pages) {
    const source = page.source ?? '';
    const title = page.title ?? 'Unknown';
    const refs = parseRefs(source, title, priorSentences, null);
    allCitations.push(...refs);  // spread: push each ref individually (not the array as one item)
  }

  const uniqueAfterParse = new Set(allCitations.map(uniqueCitationKey)).size;
  console.error(`Refs extracted: ${allCitations.length}, unique citations: ${uniqueAfterParse}`);

  // --- Step 2: Filter by citation type + link quality ---
  const withLink = allCitations.filter((citation) => {
    if (!citation.link || !citation.link.startsWith('http') || !citationTypes.has(citation.type)) {
      return false;
    }
    const linkLower = citation.link.toLowerCase();
    if (excludeUrlPatterns.some((pattern) => linkLower.includes(pattern))) {
      return false;
    }
    return true;
  });
  const uniqueAfterLink = new Set(withLink.map(uniqueCitationKey)).size;
  console.error(`After whitelist+link filter: refs ${withLink.length}, unique citations ${uniqueAfterLink}`);

  // --- Step 3: Minisearch relevance filter ---
  const searchIndex = new MiniSearch({
    fields: ['blurb', 'sentence'],
    storeFields: ['blurb', 'sentence', 'link', 'article_title', 'section'],
    searchOptions: { combineWith: 'OR', fuzzy: minisearchFuzzy },
  });

  withLink.forEach((citation, index) => {
    searchIndex.add({ id: String(index), ...citation });  // ... = spread: copy all citation props
  });

  // Tokenize terms: split phrases into words, skip short/generic ones
  const termsToSearch = new Set();
  for (const term of searchTerms) {
    if (!term || typeof term !== 'string') continue;
    const words = term.split(/\s+/).filter((word) => word.length >= minTermLength);
    words.forEach((word) => termsToSearch.add(word.toLowerCase()));
  }

  // RRF: for each term, get ranked results; for each citation, sum 1/(k+rank)
  const RRF_K = rrfK;
  const rrfScoreByIndex = {};
  const matchCountByIndex = {};

  for (const term of termsToSearch) {
    const results = searchIndex.search(term, { limit: 5000 });
    results.forEach((result, index) => {
      const rank = index + 1;  // 1-based
      const rrfContrib = 1 / (RRF_K + rank);
      rrfScoreByIndex[result.id] = (rrfScoreByIndex[result.id] ?? 0) + rrfContrib;
      matchCountByIndex[result.id] = (matchCountByIndex[result.id] ?? 0) + 1;
    });
  }

  const scored = withLink
    .map((citation, index) => ({
      citation,
      score: rrfScoreByIndex[String(index)] ?? 0,
      matchCount: matchCountByIndex[String(index)] ?? 0,
    }))
    .filter((item) => item.matchCount >= minTermsMatched);

  const filtered = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topk)
    .map((item) => item.citation);

  const uniqueAfterMinisearch = new Set(filtered.map(uniqueCitationKey)).size;
  console.error(`After minisearch filter: refs ${scored.length}, unique citations ${new Set(scored.map((s) => uniqueCitationKey(s.citation))).size}`);
  console.error(`Top ${topk} by RRF: refs ${filtered.length}, unique citations ${uniqueAfterMinisearch}`);

  // --- Step 4: Group by article and section, then write YAML ---
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

  console.error(`Wrote to ${outputPath} (${filtered.length} refs, ${uniqueAfterMinisearch} unique citations)`);
}

// Run main; .catch handles any rejected promise (e.g. thrown errors)
main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
