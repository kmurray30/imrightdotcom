#!/usr/bin/env node
/**
 * Generates a list of possible bad-faith argument angles for a given topic.
 * Each angle includes search queries to find corroborating articles.
 * Uses Grok 4.1 fast non-reasoning via XAI API.
 *
 * Usage: node generate-angles.js <topic>
 *   or:  echo "<topic>" | node generate-angles.js
 *
 * Requires XAI_API_KEY in environment (or env.local in project root).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load env from env.local or .env in project root
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

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = 'grok-4-1-fast-non-reasoning';

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system_prompt.txt'),
  'utf8'
).trim();

async function callGrok(topic) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY is required. Set it in env or add to env.local in project root.');
  }

  const response = await fetch(XAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Topic: ${topic}\n\nGenerate bad-faith argument angles and search queries for this topic.`,
        },
      ],
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`XAI API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;
  const content = message?.content;
  const refusal = message?.refusal;

  if (refusal) {
    throw new Error(`Grok refused the request: ${refusal}`);
  }

  if (!content || (typeof content === 'string' && content.trim() === '')) {
    const debug = JSON.stringify(
      { choices: data.choices, usage: data.usage, model: data.model },
      null,
      2
    );
    throw new Error(`No content in XAI API response. Raw response:\n${debug}`);
  }

  return content;
}

function parseJsonResponse(rawContent) {
  // Strip markdown code blocks if present
  let content = rawContent.trim();
  const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (codeBlockMatch) {
    content = codeBlockMatch[1].trim();
  }
  return JSON.parse(content);
}

/** Convert topic to a safe filename: lowercase, spaces to hyphens, strip non-alphanumeric. */
function topicToFilename(topic) {
  return topic
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
    || 'untitled';
}

function getTopicFromArgs() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return args.join(' ');
  }
  // Check stdin (non-TTY)
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
  const rawContent = await callGrok(topic);

  let parsed;
  try {
    parsed = parseJsonResponse(rawContent);
  } catch (parseError) {
    console.error('Failed to parse JSON from Grok response:');
    console.error(rawContent);
    throw parseError;
  }

  // Accept top-level array or { angles: [...] }
  const rawAngles = Array.isArray(parsed) ? parsed : (parsed.angles ?? []);
  if (rawAngles.length === 0) {
    throw new Error(
      `Grok returned empty angles. Raw response:\n${rawContent}`
    );
  }

  // Normalize: use search_queries, accepting search_goals as fallback
  const angles = rawAngles.map((angle) => ({
    argument: angle.argument,
    search_queries: angle.search_queries ?? angle.search_goals ?? [],
  }));

  const output = {
    topic,
    generated_at: new Date().toISOString(),
    angles,
  };

  const filename = `${topicToFilename(topic)}.json`;
  const outputDir = path.join(__dirname, 'conspiracies');
  const outputPath = path.join(outputDir, filename);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');

  console.error(`Wrote to ${outputPath}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
