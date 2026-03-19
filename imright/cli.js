#!/usr/bin/env node
/**
 * CLI for imright: runs the full pipeline from claim to tabloid HTML.
 *
 * Usage: node imright/cli.js "<claim>"
 *   or:  echo "<claim>" | node imright/cli.js
 *
 * Requires: XAI_API_KEY in environment (or env.local in project root)
 * Outputs: conspirator/conspiracies/, wiki_searcher/wikis-fetched/, wiki_filterer/wikis-filtered/,
 *          article_extractor/extracted/, tabloid_generator/output/
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { runPipeline } from './index.js';

/** Open file in default browser (macOS: open, Windows: start, Linux: xdg-open). */
function openInBrowser(filePath) {
  const absolutePath = path.resolve(filePath);
  const command =
    process.platform === 'darwin'
      ? `open "${absolutePath}"`
      : process.platform === 'win32'
        ? `start "" "${absolutePath}"`
        : `xdg-open "${absolutePath}"`;
  exec(command, (err) => {
    if (err) console.error('Could not open in browser:', err.message);
  });
}

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

async function getClaimFromArgs() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return args.join(' ');
  }
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => resolve(input.trim()));
      process.stdin.on('error', reject);
    });
  }
  return null;
}

async function main() {
  const claim = await getClaimFromArgs();
  if (!claim) {
    console.error('Usage: node imright/cli.js "<claim>"');
    console.error('   or: echo "<claim>" | node imright/cli.js');
    process.exit(1);
  }

  const onProgress = (step, total, message) => {
    console.error(`[${step}/${total}] ${message}`);
  };

  const result = await runPipeline(claim, { onProgress });

  const outputPath = path.join(PROJECT_ROOT, 'tabloid_generator', 'output', `${result.slug}.html`);
  console.error(`Done. Output: tabloid_generator/output/${result.slug}.html`);
  openInBrowser(outputPath);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
