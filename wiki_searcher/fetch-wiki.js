#!/usr/bin/env node
/**
 * Fetches Wikipedia data via the MediaWiki API and dumps it to a YAML file.
 * Takes a claim, loads search queries from conspirator output, fetches for each query,
 * and writes a single union file of all articles (deduped by pageid).
 *
 * Usage: node fetch-wiki.js "<claim>"
 *
 * Requires: conspirator/conspiracies/<claim>.json
 * Output: wiki_searcher/wikis-fetched/<claim>.yaml
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const EXTRACT_CHARS_PER_PAGE = 1200; // API max for extracts

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

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'imright-wiki-fetcher/1.0 (educational use)';

async function fetchFromMediaWiki(params) {
  const url = new URL(WIKI_API);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`MediaWiki API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function searchPages(query, limit) {
  const data = await fetchFromMediaWiki({
    action: 'query',
    list: 'search',
    srsearch: query,
    format: 'json',
    srlimit: limit,
  });

  return data.query.search.map((result) => ({
    title: result.title,
    pageid: result.pageid,
    snippet: result.snippet,
    size: result.size,
    wordcount: result.wordcount,
  }));
}

async function fetchPageData(searchResults) {
  if (searchResults.length === 0) return [];

  const data = await fetchFromMediaWiki({
    action: 'query',
    prop: 'extracts|revisions',
    exintro: false,
    explaintext: true,
    exchars: EXTRACT_CHARS_PER_PAGE,
    rvprop: 'ids|timestamp|content',
    rvslots: 'main',
    titles: searchResults.map((page) => page.title).join('|'),
    format: 'json',
  });

  const pages = data.query.pages;
  const results = [];

  for (const pageId of Object.keys(pages)) {
    const page = pages[pageId];
    const revision = page.revisions?.[0];
    const mainSlot = revision?.slots?.main;
    const source = mainSlot?.['*'] ?? mainSlot?.content ?? '';

    results.push({
      pageid: page.pageid,
      title: page.title,
      extract: page.extract?.trim() ?? '',
      source: source.trim(),
      revision_id: revision?.revid,
      last_modified: revision?.timestamp,
    });
  }

  return results;
}

async function main() {
  const claim = process.argv.slice(2).join(' ').trim();
  if (!claim) {
    console.error('Usage: node fetch-wiki.js "<claim>"');
    process.exit(1);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const conspiratorPath = path.join(projectRoot, 'conspirator', 'conspiracies', `${queryToFilename(claim)}.json`);

  if (!fs.existsSync(conspiratorPath)) {
    console.error(`Conspirator file not found: ${conspiratorPath}`);
    process.exit(1);
  }

  const conspiracy = JSON.parse(fs.readFileSync(conspiratorPath, 'utf8'));
  const searchQueries = (conspiracy.angles ?? []).flatMap((angle) => angle.search_queries ?? []).filter(Boolean);

  if (searchQueries.length === 0) {
    console.error('No search queries found in conspiracy file.');
    process.exit(1);
  }

  const configPath = path.join(__dirname, 'config.yaml');
  const config = fs.existsSync(configPath)
    ? yaml.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  const articlesPerQuery = config.articles_per_query ?? 10;

  const pagesById = new Map();

  for (const searchQuery of searchQueries) {
    console.log(`Searching Wikipedia for "${searchQuery}"...`);
    const searchResults = await searchPages(searchQuery, articlesPerQuery);

    if (searchResults.length === 0) {
      console.log(`  No pages found.`);
      continue;
    }

    console.log(`  Found: ${searchResults.map((r) => r.title).join(', ')}`);
    const pageData = await fetchPageData(searchResults);

    const searchByTitle = Object.fromEntries(searchResults.map((r) => [r.title, r]));
    for (const page of pageData) {
      if (pagesById.has(page.pageid)) continue;
      const searchMeta = searchByTitle[page.title];
      pagesById.set(page.pageid, {
        title: page.title,
        pageid: page.pageid,
        extract: page.extract,
        source: page.source,
        revision_id: page.revision_id,
        last_modified: page.last_modified,
        ...(searchMeta && {
          snippet: searchMeta.snippet,
          size_bytes: searchMeta.size,
          wordcount: searchMeta.wordcount,
        }),
      });
    }
  }

  const pages = Array.from(pagesById.values());
  const outputPath = path.join(__dirname, 'wikis-fetched', `${queryToFilename(claim)}.yaml`);

  const output = {
    query: claim,
    search_queries: searchQueries,
    fetched_at: new Date().toISOString(),
    page_count: pages.length,
    pages,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.stringify(output, { lineWidth: 0 }), 'utf8');
  console.log(`Done. Wrote ${pages.length} articles to ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
