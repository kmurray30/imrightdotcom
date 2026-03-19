#!/usr/bin/env node
/**
 * CLI for tabloid_generator: generates tabloid-style HTML from extracted citations.
 *
 * Usage: node generate.js "<argument string>"
 *
 * Requires: article_extractor/extracted/<slug>.yaml
 * Requires: XAI_API_KEY in environment (or env.local in project root)
 * Output: tabloid_generator/output/<slug>.html
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { generate } from './index.js';

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
    console.error('Usage: node generate.js "<argument string>"');
    process.exit(1);
  }

  const slug = queryToFilename(claim);
  const yamlPath = path.join(PROJECT_ROOT, 'article_extractor', 'extracted', `${slug}.yaml`);

  if (!fs.existsSync(yamlPath)) {
    console.error(`Extracted YAML not found: ${yamlPath}`);
    process.exit(1);
  }

  const parsedYaml = yaml.parse(fs.readFileSync(yamlPath, 'utf8'));
  const html = await generate(claim, parsedYaml);

  const outputDir = path.join(__dirname, 'output');
  const outputPath = path.join(outputDir, `${slug}.html`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  console.error(`Wrote to ${outputPath}`);
  openInBrowser(outputPath);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
