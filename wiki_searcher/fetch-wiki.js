#!/usr/bin/env node
/**
 * Fetches Wikipedia data via the MediaWiki API and dumps it to a YAML file.
 * Standalone script - not connected to the rest of the codebase.
 *
 * Usage: node fetch-wiki.js <search query>
 *
 * Output: wiki_searcher/wikis-fetched/<query>.yaml
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const MAX_SEARCH_RESULTS = 20;
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

async function searchPages(query) {
  const data = await fetchFromMediaWiki({
    action: 'query',
    list: 'search',
    srsearch: query,
    format: 'json',
    srlimit: MAX_SEARCH_RESULTS,
  });

  return data.query.search.map((result) => ({
    title: result.title,
    pageid: result.pageid,
    snippet: result.snippet,
    size: result.size,
    wordcount: result.wordcount,
  }));
}

async function fetchPageData(titles) {
  const data = await fetchFromMediaWiki({
    action: 'query',
    prop: 'extracts|revisions',
    exintro: false,
    explaintext: true,
    exchars: EXTRACT_CHARS_PER_PAGE,
    rvprop: 'ids|timestamp|content',
    rvslots: 'main',
    titles: titles.map((page) => page.title).join('|'),
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
  const searchQuery = process.argv.slice(2).join(' ').trim();
  if (!searchQuery) {
    console.error('Usage: node fetch-wiki.js <search query>');
    process.exit(1);
  }

  const outputFilename = `wikis-fetched/${queryToFilename(searchQuery)}.yaml`;
  const outputPath = path.join(__dirname, outputFilename);

  console.log(`Searching Wikipedia for "${searchQuery}"...`);
  const searchResults = await searchPages(searchQuery);

  if (searchResults.length === 0) {
    console.log('No pages found.');
    process.exit(1);
  }

  console.log(`Found: ${searchResults.map((r) => r.title).join(', ')}`);
  console.log('Fetching page content...');

  const pageData = await fetchPageData(searchResults);

  // Merge search metadata (snippet, size, wordcount) into page data
  const searchByTitle = Object.fromEntries(searchResults.map((r) => [r.title, r]));
  const pages = pageData.map((page) => {
    const searchMeta = searchByTitle[page.title];
    return {
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
    };
  });

  const output = {
    query: searchQuery,
    fetched_at: new Date().toISOString(),
    page_count: pages.length,
    pages,
  };

  const yamlOutput = yaml.stringify(output, { lineWidth: 0 });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yamlOutput, 'utf8');
  console.log(`Done. Wrote to ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
