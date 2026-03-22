#!/usr/bin/env node
/**
 * Check if links are dead (HEAD-only ping). Wrapper around utils/linkChecker.
 *
 * Usage:
 *   node check_dead_links.js
 *   node check_dead_links.js --links-file path/to/urls.txt
 *   node check_dead_links.js --delay 1.0
 *
 * By default reads URLs from links.txt in the same directory (one per line, # for comments).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkUrls, LinkStatus } from '../utils/linkChecker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LINKS_FILE = path.join(__dirname, 'links.txt');

function loadUrlsFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function main() {
  const args = process.argv.slice(2);
  let linksFile = DEFAULT_LINKS_FILE;
  let delaySeconds = 0.5;
  let timeoutSeconds = 18;

  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--links-file' && args[index + 1]) {
      linksFile = args[++index];
    } else if (args[index] === '--delay' && args[index + 1]) {
      delaySeconds = parseFloat(args[++index], 10);
    } else if (args[index] === '--timeout' && args[index + 1]) {
      timeoutSeconds = parseInt(args[++index], 10);
    }
  }

  let urls;
  try {
    urls = loadUrlsFromFile(linksFile);
  } catch (error) {
    console.error(`check_dead_links: cannot read links file ${linksFile}: ${error.message}`);
    process.exit(1);
  }

  if (urls.length === 0) {
    console.error(`check_dead_links: no URLs in ${linksFile} (empty or only comments).`);
    process.exit(1);
  }

  checkUrls(urls, {
    timeoutMs: timeoutSeconds * 1000,
    delayMs: delaySeconds * 1000,
  }).then((results) => {
    const counts = {
      [LinkStatus.INVALID]: 0,
      [LinkStatus.PROBABLY_VALID]: 0,
      [LinkStatus.FORBIDDEN]: 0,
      [LinkStatus.WHITELISTED]: 0,
      [LinkStatus.TIMEOUT]: 0,
    };
    let hasProblem = false;

    for (const { url, linkStatus, issueType, detail } of results) {
      counts[linkStatus]++;
      if (
        linkStatus !== LinkStatus.PROBABLY_VALID &&
        linkStatus !== LinkStatus.WHITELISTED
      )
        hasProblem = true;

      const statusStr = linkStatus.toUpperCase();
      const issueStr = issueType ? ` [${issueType}]` : '';
      const padded = `${statusStr}${issueStr}`.padEnd(30);
      console.log(detail ? `${padded} ${url} ${detail}` : `${padded} ${url}`);
    }

    console.log();
    console.log(
      `Summary: ${results.length} checked — INVALID: ${counts[LinkStatus.INVALID]}, ` +
        `PROBABLY_VALID: ${counts[LinkStatus.PROBABLY_VALID]}, FORBIDDEN: ${counts[LinkStatus.FORBIDDEN] || 0}, ` +
        `WHITELISTED: ${counts[LinkStatus.WHITELISTED] || 0}, ` +
        `TIMEOUT: ${counts[LinkStatus.TIMEOUT] || 0}`
    );

    process.exit(hasProblem ? 1 : 0);
  }).catch((error) => {
    console.error('check_dead_links:', error.message);
    process.exit(1);
  });
}

main();
