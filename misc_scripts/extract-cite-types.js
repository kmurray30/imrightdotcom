#!/usr/bin/env node
/**
 * Scans all wiki YAML files under wiki_searcher/wikis-fetched for {{cite X}} templates
 * and outputs a sorted list of all unique cite types found.
 *
 * Usage: node extract-cite-types.js
 * Output: misc_scripts/output.txt
 */

const fs = require('fs');
const path = require('path');

const WIKIS_DIR = path.join(__dirname, '..', 'wiki_searcher', 'wikis-fetched');
const OUTPUT_FILE = path.join(__dirname, 'output.txt');

// Match {{cite X | or {{Cite X| - full phrase up to the pipe (capture exact string)
const CITE_PATTERN = /\{\{[Cc]ite\s+[\w-]+\s*\|/g;

// Map: normalized phrase -> { count, articles: Set of filenames }
const citeData = new Map();

// Get all YAML files in wikis-fetched
const wikiFiles = fs.readdirSync(WIKIS_DIR).filter((filename) => filename.endsWith('.yaml'));

for (const filename of wikiFiles) {
  const filePath = path.join(WIKIS_DIR, filename);
  const content = fs.readFileSync(filePath, 'utf-8');

  let match;
  while ((match = CITE_PATTERN.exec(content)) !== null) {
    // Normalize: strip {{ and |, collapse whitespace, lowercase (case + space insensitive)
    const normalized = match[0]
      .replace(/\{\{|\|/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const entry = citeData.get(normalized) ?? { count: 0, articles: new Set() };
    entry.count += 1;
    entry.articles.add(filename);
    citeData.set(normalized, entry);
  }
}

// Sort by hit count descending
const sortedEntries = [...citeData.entries()].sort((a, b) => b[1].count - a[1].count);
const output = sortedEntries
  .map(([phrase, { count, articles }]) => {
    const articlesList = [...articles].sort().join(', ');
    return `${phrase} - ${count} (${articlesList})`;
  })
  .join('\n') + '\n';

fs.writeFileSync(OUTPUT_FILE, output, 'utf-8');
console.log(`Found ${citeData.size} unique cite types. Output written to ${OUTPUT_FILE}`);
