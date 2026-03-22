#!/usr/bin/env node
/**
 * Extract all links from whitelisted citation types in wiki_searcher/wikis-fetched,
 * trim to base URL, dedupe, concurrently HEAD-check each, and output three files:
 * valid_links, invalid_links, unknown_links (each sorted by frequency desc).
 * Unknown links include the exact error type (e.g. http_403, connection timeout).
 *
 * Usage: node misc_scripts/extract-and-validate-links.js
 *        node misc_scripts/extract-and-validate-links.js --concurrency 20
 *        node misc_scripts/extract-and-validate-links.js --output-dir ./output
 *        node misc_scripts/extract-and-validate-links.js --limit 100   # only check first N URLs (for testing)
 *        node misc_scripts/extract-and-validate-links.js --low-pass 5  # only check links with >= 5 occurrences
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { parseRefs } from '../ref_extractor/parser/index.js';
import { checkUrl, LinkStatus } from '../utils/linkChecker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WIKIS_FETCHED_DIR = path.join(REPO_ROOT, 'wiki_searcher', 'wikis-fetched');
const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'link_validation_output');

// Whitelisted citation types from ref_extractor config.yaml
const WHITELIST_TYPES = new Set([
  'web',
  'news',
  'journal',
  'magazine',
  'report',
  'dictionary',
  'encyclopedia',
]);

/**
 * Trim URL to base (origin: protocol + host).
 */
function toBaseUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.origin;
  } catch {
    return null;
  }
}

const PROGRESS_BAR_WIDTH = 30;

/**
 * Update a progress bar on stderr. Call with completed count and total.
 */
function updateProgressBar(completed, total) {
  const percent = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  const filled = Math.min(PROGRESS_BAR_WIDTH, Math.round((percent / 100) * PROGRESS_BAR_WIDTH));
  const remainder = Math.max(0, PROGRESS_BAR_WIDTH - filled - 1);
  const bar = '[' + '='.repeat(filled) + '>'.repeat(filled < PROGRESS_BAR_WIDTH ? 1 : 0) + ' '.repeat(remainder) + ']';
  const text = `\r${bar} ${completed}/${total} (${percent.toFixed(1)}%)  `;
  process.stderr.write(text);
}

/**
 * Run async tasks with limited concurrency.
 * @param {Function} [onProgress] - Optional callback(completed, total) invoked when each task finishes
 */
async function runConcurrently(items, concurrency, task, onProgress) {
  const results = [];
  let index = 0;
  let completed = 0;
  const total = items.length;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      if (currentIndex >= items.length) break;
      const item = items[currentIndex];
      const result = await task(item);
      results[currentIndex] = result;
      completed++;
      if (onProgress) onProgress(completed, total);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

function main() {
  const args = process.argv.slice(2);
  let concurrency = 20;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let limit = null;
  let lowPassMin = null;

  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--concurrency' && args[index + 1]) {
      concurrency = parseInt(args[++index], 10);
    } else if (args[index] === '--output-dir' && args[index + 1]) {
      outputDir = args[++index];
    } else if (args[index] === '--limit' && args[index + 1]) {
      limit = parseInt(args[++index], 10);
    } else if (args[index] === '--low-pass' && args[index + 1]) {
      lowPassMin = parseInt(args[++index], 10);
    }
  }

  // 1. Find all YAML files in wikis-fetched
  const wikiFiles = fs
    .readdirSync(WIKIS_FETCHED_DIR)
    .filter((filename) => filename.endsWith('.yaml'))
    .map((filename) => path.join(WIKIS_FETCHED_DIR, filename));

  if (wikiFiles.length === 0) {
    console.error(`No .yaml files found in ${WIKIS_FETCHED_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${wikiFiles.length} wiki files in wikis-fetched`);

  // 2. Extract all links from whitelisted citation types
  const allLinks = [];
  for (const filePath of wikiFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    let data;
    try {
      data = YAML.parse(content);
    } catch (error) {
      console.warn(`Skipping ${filePath}: ${error.message}`);
      continue;
    }

    const pages = data?.pages ?? [];
    for (const page of pages) {
      const source = page?.source;
      if (!source) continue;

      const citations = parseRefs(source, page.title ?? 'Unknown', 1, WHITELIST_TYPES);
      for (const citation of citations) {
        if (!WHITELIST_TYPES.has(citation.type)) continue;
        if (!citation.link || !citation.link.startsWith('http')) continue;
        allLinks.push(citation.link);
      }
    }
  }

  console.log(`Extracted ${allLinks.length} raw links from whitelisted citation types`);

  // 3. Trim to base URL and count frequency
  const baseUrlToCount = new Map();
  for (const link of allLinks) {
    const base = toBaseUrl(link);
    if (!base) continue;
    baseUrlToCount.set(base, (baseUrlToCount.get(base) ?? 0) + 1);
  }

  let uniqueBaseUrls = [...baseUrlToCount.keys()];
  if (lowPassMin != null && lowPassMin > 0) {
    uniqueBaseUrls = uniqueBaseUrls.filter((baseUrl) => baseUrlToCount.get(baseUrl) >= lowPassMin);
    console.log(`Low-pass filter: keeping only links with >= ${lowPassMin} occurrences (${uniqueBaseUrls.length} remaining)`);
  }
  if (limit != null && limit > 0) {
    uniqueBaseUrls = uniqueBaseUrls
      .sort((a, b) => baseUrlToCount.get(b) - baseUrlToCount.get(a))
      .slice(0, limit);
    console.log(`Limiting to top ${limit} most-frequent URLs (--limit)`);
  }
  console.log(`Unique base URLs to check: ${uniqueBaseUrls.length}`);

  // 4. Concurrently HEAD-check each unique base URL
  console.log(`Checking ${uniqueBaseUrls.length} URLs with concurrency ${concurrency}...`);

  runConcurrently(
    uniqueBaseUrls,
    concurrency,
    async (baseUrl) => {
      const result = await checkUrl(baseUrl);
      return { baseUrl, ...result };
    },
    (completed, total) => updateProgressBar(completed, total)
  ).then((results) => {
    process.stderr.write('\n');
    // 5. Categorize into valid, invalid, unknown
    const valid = [];
    const invalid = [];
    const unknown = [];

    for (const record of results) {
      const count = baseUrlToCount.get(record.baseUrl);
      const entry = { baseUrl: record.baseUrl, count };

      if (record.linkStatus === LinkStatus.PROBABLY_VALID) {
        valid.push(entry);
      } else if (record.linkStatus === LinkStatus.INVALID) {
        invalid.push({ ...entry, issueType: record.issueType ?? 'unknown', detail: record.detail ?? '' });
      } else {
        // UNKNOWN: include exact error type
        unknown.push({
          ...entry,
          issueType: record.issueType ?? 'unknown',
          detail: record.detail ?? '',
        });
      }
    }

    // 6. Sort by count descending
    const byCountDesc = (a, b) => b.count - a.count;
    valid.sort(byCountDesc);
    invalid.sort(byCountDesc);
    unknown.sort(byCountDesc);

    // 7. Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // 8. Write output files
    const writeLines = (filePath, items, formatter) => {
      const lines = items.map(formatter);
      fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    };

    writeLines(
      path.join(outputDir, 'valid_links.txt'),
      valid,
      (entry) => `${entry.count}\t${entry.baseUrl}`
    );
    writeLines(
      path.join(outputDir, 'invalid_links.txt'),
      invalid,
      (entry) => `${entry.count}\t${entry.baseUrl}\t${entry.issueType} ${entry.detail}`.trim()
    );
    writeLines(
      path.join(outputDir, 'unknown_links.txt'),
      unknown,
      (entry) => `${entry.count}\t${entry.baseUrl}\t${entry.issueType} ${entry.detail}`.trim()
    );

    console.log(`\nOutput written to ${outputDir}/`);
    console.log(`  valid_links.txt:   ${valid.length} (descending by frequency)`);
    console.log(`  invalid_links.txt: ${invalid.length} (descending by frequency)`);
    console.log(`  unknown_links.txt: ${unknown.length} (descending by frequency, with exact error type)`);
  }).catch((error) => {
    console.error('Error during link validation:', error);
    process.exit(1);
  });
}

main();
