#!/usr/bin/env node
/**
 * Filters Wikipedia articles for relevance to arguments from a conspiracy file.
 * Loads pages from wiki_searcher/wikis-fetched/<claim>.yaml, sends each argument to Grok,
 * and writes a single union of all filtered articles to wiki_filterer/wikis-filtered/<claim>.yaml.
 *
 * Usage: node filter-wiki.js "<claim>"
 *
 * Requires: conspirator/conspiracies/<claim>.json, wiki_searcher/wikis-fetched/<claim>.yaml
 * Requires: XAI_API_KEY in environment (or env.local in project root)
 * Output: wiki_filterer/wikis-filtered/<claim>.yaml
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

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

function parseJsonResponse(rawContent) {
  let content = rawContent.trim();
  const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (codeBlockMatch) {
    content = codeBlockMatch[1].trim();
  }
  return JSON.parse(content);
}

async function callGrok(argument, pageObjects) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY is required. Set it in env or add to env.local in project root.');
  }

  const userMessage = `Argument: ${argument}

Wikipedia articles to filter:

${JSON.stringify(pageObjects, null, 2)}

Return only the articles relevant to this argument as a JSON array of {title, id} objects.`;

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
        { role: 'user', content: userMessage },
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

async function main() {
  const claim = process.argv.slice(2).join(' ').trim();
  if (!claim) {
    console.error('Usage: node filter-wiki.js "<claim>"');
    process.exit(1);
  }

  const filename = `${queryToFilename(claim)}.yaml`;
  const conspiratorPath = path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${queryToFilename(claim)}.json`);
  const wikiPath = path.join(PROJECT_ROOT, 'wiki_searcher', 'wikis-fetched', filename);

  if (!fs.existsSync(conspiratorPath)) {
    console.error(`Conspirator file not found: ${conspiratorPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(wikiPath)) {
    console.error(`Wiki YAML not found: ${wikiPath}`);
    process.exit(1);
  }

  const conspiracy = JSON.parse(fs.readFileSync(conspiratorPath, 'utf8'));
  const argumentsList = (conspiracy.angles ?? []).map((angle) => angle.argument).filter(Boolean);

  if (argumentsList.length === 0) {
    console.error('No arguments found in conspiracy file.');
    process.exit(1);
  }

  const parsed = yaml.parse(fs.readFileSync(wikiPath, 'utf8'));
  const pages = parsed?.pages;

  if (!pages || !Array.isArray(pages) || pages.length === 0) {
    console.error('No pages found in YAML or invalid structure.');
    process.exit(1);
  }

  const pagesByPageid = new Map(pages.map((page) => [page.pageid, page]));
  const pagesByTitle = new Map(pages.map((page) => [page.title, page]));

  const pageObjects = pages.map((page) => ({
    title: page.title ?? null,
    pageid: page.pageid ?? null,
    extract: page.extract ?? null,
  }));

  const seenPageids = new Set();
  const filteredPages = [];

  for (const argument of argumentsList) {
    console.error(`Filtering ${pageObjects.length} articles for argument: "${argument.slice(0, 60)}..."`);
    const rawContent = await callGrok(argument, pageObjects);

    let parsedResponse;
    try {
      parsedResponse = parseJsonResponse(rawContent);
    } catch (parseError) {
      console.error('Failed to parse JSON from Grok response:');
      console.error(rawContent);
      throw parseError;
    }

    const rawList = Array.isArray(parsedResponse) ? parsedResponse : (parsedResponse.articles ?? []);

    for (const item of rawList) {
      const pageid = item.id ?? item.pageid ?? item.pageId;
      const title = item.title ?? item.Title;
      let page = pageid ? pagesByPageid.get(pageid) : null;
      if (!page && title) {
        page = pagesByTitle.get(title);
      }
      if (page && !seenPageids.has(page.pageid)) {
        seenPageids.add(page.pageid);
        filteredPages.push(page);
      }
    }
  }

  const output = {
    query: claim,
    arguments: argumentsList,
    fetched_at: parsed.fetched_at ?? null,
    filtered_at: new Date().toISOString(),
    page_count: filteredPages.length,
    pages: filteredPages,
  };

  const outputDir = path.join(__dirname, 'wikis-filtered');
  const outputPath = path.join(outputDir, filename);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, yaml.stringify(output, { lineWidth: 0 }), 'utf8');

  console.error(`Wrote ${filteredPages.length} articles to ${outputPath}`);
  console.log(JSON.stringify(filteredPages.map((page) => ({ title: page.title, id: page.pageid })), null, 2));
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
