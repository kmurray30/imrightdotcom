#!/usr/bin/env node
/**
 * Generates a tabloid-style HTML page from extracted YAML citations.
 * Uses XAI API to select the best 5-10 arguments and 5-10 links.
 *
 * Usage: node generate.js "<argument string>"
 *
 * Requires: article_extractor/extracted/<slug>.yaml
 * Requires: XAI_API_KEY in environment (or env.local in project root)
 * Output: tabloid_generator/output/<slug>.html
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const MAX_CITATIONS_FOR_LLM = 80;

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
  return (
    query
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'untitled'
  );
}

/** Strip [REF] placeholders and ''italic'' wiki markup for readability. */
function cleanSentence(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\[REF\]/g, '')
    .replace(/''/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Flatten YAML structure (Article -> Section -> citations) into a deduplicated list. */
function flattenAndDedupeCitations(parsedYaml) {
  const seen = new Set();
  const citations = [];

  for (const articleTitle of Object.keys(parsedYaml ?? {})) {
    const sections = parsedYaml[articleTitle];
    if (!sections || typeof sections !== 'object') continue;

    for (const sectionName of Object.keys(sections)) {
      const items = sections[sectionName];
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        const link = item?.link;
        const blurb = item?.blurb ?? '';
        const sentence = cleanSentence(item?.sentence ?? '');
        if (!link || !link.startsWith('http')) continue;

        const key = link + '|' + blurb;
        if (seen.has(key)) continue;
        seen.add(key);

        citations.push({ link, blurb, sentence, articleTitle, sectionName });
      }
    }
  }

  return citations;
}

/** Condense citations for LLM: cap count to avoid token overflow. */
function condenseForLlm(citations) {
  return citations.slice(0, MAX_CITATIONS_FOR_LLM);
}

function parseJsonResponse(rawContent) {
  let content = rawContent.trim();
  const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (codeBlockMatch) {
    content = codeBlockMatch[1].trim();
  }
  return JSON.parse(content);
}

async function callGrok(topic, candidateArguments, uniqueLinks) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY is required. Set it in env or add to env.local in project root.');
  }

  const userMessage = `Topic/claim: ${topic}

Source material (use this as evidence to write your article; each has text, blurb, link):
${JSON.stringify(candidateArguments, null, 2)}

Unique links with blurbs (cite 5-10 of these as footnotes):
${JSON.stringify(uniqueLinks, null, 2)}

Write a tabloid-style ARTICLE (4-8 paragraphs of flowing prose). Use the source material as evidence. Return JSON with headline, paragraphs (each with text and link_refs), and links.`;

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

/** Build URL-to-index map for footnote-style refs [1], [2], etc. */
function buildUrlToIndex(links) {
  const urlToIndex = new Map();
  for (let index = 0; index < links.length; index++) {
    urlToIndex.set(links[index].url, index + 1);
  }
  return urlToIndex;
}

/** Escape HTML for safe output. */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generate self-contained tabloid-style HTML. */
function generateHtml(selected, topic) {
  const headline = selected.headline ?? 'TRUTH FLASH!';
  const paragraphs = selected.paragraphs ?? [];
  const links = selected.links ?? [];
  const urlToIndex = buildUrlToIndex(links);

  const paragraphsHtml = paragraphs
    .map((paragraph) => {
      const text = escapeHtml(paragraph.text ?? '');
      const refUrls = paragraph.link_refs ?? [];
      const refIndices = refUrls
        .map((url) => urlToIndex.get(url))
        .filter(Boolean)
        .sort((a, b) => a - b);
      const refsHtml =
        refIndices.length > 0
          ? ` <sup>[${refIndices.join(', ')}]</sup>`
          : '';
      return `    <p class="article__paragraph">${text}${refsHtml}</p>`;
    })
    .join('\n');

  const linksHtml = links
    .map(
      (link, index) =>
        `    <li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener">[${index + 1}] ${escapeHtml(link.label ?? link.url)}</a></li>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(headline)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Caudex:ital,wght@0,400;0,700;1,400;1,700&family=Impact,sans-serif&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Caudex, Georgia, serif;
      background: #1a1a2e;
      color: #eee;
      line-height: 1.6;
    }
    .container { max-width: 720px; margin: 0 auto; padding: 2rem; }
    .masthead {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 3px solid #e63946;
    }
    .masthead__label {
      font-size: 0.9rem;
      letter-spacing: 0.2em;
      color: #e63946;
      text-transform: uppercase;
      margin-bottom: 0.5rem;
    }
    .headline {
      font-family: Impact, "Arial Black", sans-serif;
      font-size: 2.2rem;
      line-height: 1.2;
      color: #fff;
      margin: 0;
    }
    .subtitle {
      font-size: 0.95rem;
      color: #aaa;
      margin-top: 0.5rem;
    }
    .article { margin: 2rem 0; }
    .article__paragraph {
      margin: 0 0 1.25rem 0;
      text-align: justify;
    }
    .article__paragraph:last-of-type { margin-bottom: 0; }
    .article__paragraph sup { color: #e63946; }
    .article__paragraph a { color: #6df4a1; }
    .sources { margin-top: 2.5rem; }
    .sources h2 {
      font-size: 1.2rem;
      color: #e63946;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 1rem;
    }
    .sources ul { list-style: none; padding: 0; margin: 0; }
    .sources li { margin-bottom: 0.5rem; }
    .sources a {
      color: #6df4a1;
      text-decoration: none;
    }
    .sources a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header class="masthead">
      <p class="masthead__label">FACTS NEWS</p>
      <h1 class="headline">${escapeHtml(headline)}</h1>
      <p class="subtitle">${escapeHtml(topic)}</p>
    </header>
    <article class="article">
${paragraphsHtml}
    </article>
    <section class="sources">
      <h2>Sources</h2>
      <ul>
${linksHtml}
      </ul>
    </section>
  </div>
</body>
</html>`;
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
  const allCitations = flattenAndDedupeCitations(parsedYaml);
  const condensed = condenseForLlm(allCitations);

  // Build candidate arguments for LLM: use sentence or blurb as text
  const candidateArguments = condensed.map((citation) => ({
    text: citation.sentence || citation.blurb,
    blurb: citation.blurb,
    link: citation.link,
  }));

  // Build unique links list from condensed citations only (to limit token count)
  const linksByUrl = new Map();
  for (const citation of condensed) {
    if (citation.link && !linksByUrl.has(citation.link)) {
      try {
        const hostname = new URL(citation.link).hostname.replace(/^www\./, '');
        linksByUrl.set(citation.link, {
          url: citation.link,
          label: citation.blurb || hostname,
        });
      } catch {
        linksByUrl.set(citation.link, {
          url: citation.link,
          label: citation.blurb || citation.link,
        });
      }
    }
  }
  const uniqueLinks = Array.from(linksByUrl.values());

  console.error(`Loaded ${allCitations.length} unique citations, sending ${condensed.length} to LLM`);

  const rawContent = await callGrok(claim, candidateArguments, uniqueLinks);

  let selected;
  try {
    selected = parseJsonResponse(rawContent);
  } catch (parseError) {
    console.error('Failed to parse JSON from Grok response:');
    console.error(rawContent);
    throw parseError;
  }

  const paragraphCount = (selected.paragraphs ?? []).length;
  const linksCount = (selected.links ?? []).length;
  console.error(`Wrote ${paragraphCount} paragraphs, ${linksCount} links`);

  const html = generateHtml(selected, claim);
  const outputDir = path.join(__dirname, 'output');
  const outputPath = path.join(outputDir, `${slug}.html`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  console.error(`Wrote to ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
