#!/usr/bin/env node
/**
 * CLI for conspirator: generates bad-faith argument angles for a topic.
 *
 * Usage: node generate-angles.js <topic>
 *   or:  echo "<topic>" | node generate-angles.js
 *
 * Requires: XAI_API_KEY in environment (or env.local in project root)
 * Output: conspirator/conspiracies/<topic>.yaml
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { generateAngles } from './index.js';

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

/** Convert topic to a safe filename: lowercase, spaces to hyphens, strip non-alphanumeric. */
function topicToFilename(topic) {
  return topic
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'untitled';
}

async function getTopicFromArgs() {
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
  const topic = await getTopicFromArgs();
  if (!topic) {
    console.error('Usage: node generate-angles.js <topic>');
    console.error('   or: echo "<topic>" | node generate-angles.js');
    process.exit(1);
  }

  console.error(`Generating bad-faith angles for: "${topic}"`);
  const output = await generateAngles(topic);

  console.log(yaml.stringify(output, { lineWidth: 0 }));

  const filename = `${topicToFilename(topic)}.yaml`;
  const outputDir = path.join(__dirname, 'conspiracies');
  const outputPath = path.join(outputDir, filename);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, yaml.stringify(output, { lineWidth: 0 }), 'utf8');

  console.error(`Wrote filtered output to ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
