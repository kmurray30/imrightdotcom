#!/usr/bin/env node
/**
 * Generates a debug/visualization HTML page for a pipeline run.
 * Reads static YAML/JSON files and embeds them in a self-contained HTML file.
 *
 * Usage: node imright/scripts/generate-debug.js <slug>
 * Example: node imright/scripts/generate-debug.js wireless-headphones-can-give-you-brain-cancer
 *
 * Output: imright/debug/<slug>.html
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/** Must match tabloid_generator REF_NUMBERS_COUNT for article [1][2] numbering */
const TOP_K_REFS = 50;
const WIKI_BASE = 'https://en.wikipedia.org/wiki/';

function loadConspiracy(slug) {
  const yamlPath = path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${slug}.yaml`);
  const jsonPath = path.join(PROJECT_ROOT, 'conspirator', 'conspiracies', `${slug}.json`);
  if (fs.existsSync(yamlPath)) {
    return yaml.parse(fs.readFileSync(yamlPath, 'utf8'));
  }
  if (fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  }
  return null;
}

function loadYaml(relativePath) {
  const fullPath = path.join(PROJECT_ROOT, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return yaml.parse(fs.readFileSync(fullPath, 'utf8'));
}

function loadJson(relativePath) {
  const fullPath = path.join(PROJECT_ROOT, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function wikiUrl(title) {
  return WIKI_BASE + encodeURIComponent(title.replace(/ /g, '_'));
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip [REF] placeholders and wiki markup for display. */
function cleanSentence(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\[REF\]/g, '')
    .replace(/''/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Flatten extracted (article -> section -> citations) into deduped list. */
function flattenExtracted(extracted) {
  const seen = new Set();
  const citations = [];
  for (const articleTitle of Object.keys(extracted ?? {})) {
    const sections = extracted[articleTitle];
    if (!sections || typeof sections !== 'object') continue;
    for (const sectionName of Object.keys(sections)) {
      const items = sections[sectionName];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const link = item?.link;
        const title = item?.title ?? '';
        const content = cleanSentence(item?.content ?? '');
        const key = link + '|' + title;
        if (seen.has(key)) continue;
        seen.add(key);
        citations.push({ link, title, content, articleTitle, sectionName });
      }
    }
  }
  return citations;
}

/** Get deduped article titles from search_query_article_titles. */
function dedupedArticles(searchQueryArticleTitles) {
  const seen = new Set();
  for (const titles of Object.values(searchQueryArticleTitles ?? {})) {
    for (const title of titles) {
      seen.add(title);
    }
  }
  return Array.from(seen);
}

function formatTime(timeMs) {
  if (timeMs >= 1000) return `${(timeMs / 1000).toFixed(2)}s`;
  return `${Math.round(timeMs)}ms`;
}

function buildHtml(data) {
  const conspiracy = data.conspiracy;
  const wikisFetched = data.wikisFetched;
  const wikisFiltered = data.wikisFiltered;
  const extracted = data.extracted;
  const runStats = data.runStats;

  const topic = conspiracy?.topic ?? wikisFetched?.query ?? wikisFiltered?.query ?? data.slug;
  const angles = conspiracy?.angles ?? [];
  const searchQueryArticleTitles = wikisFetched?.search_query_article_titles ?? wikisFiltered?.search_query_article_titles ?? {};
  const dedupedTitles = dedupedArticles(searchQueryArticleTitles);
  const filteredPages = wikisFiltered?.pages ?? [];
  const topRefs = flattenExtracted(extracted).slice(0, TOP_K_REFS);
  const stages = runStats?.stages ?? [];
  const refStats = runStats?.refStats;

  const navItems = [
    { id: 'arguments', label: 'Arguments & search queries' },
    { id: 'articles-per-query', label: 'Articles per search term' },
    { id: 'deduped', label: 'Deduped articles' },
    { id: 'filtered', label: 'After quick filter' },
    { id: 'ref-counts', label: 'Ref counts' },
    { id: 'dead-links', label: 'Dead links' },
    { id: 'top-refs', label: 'Top references' },
    { id: 'tokens', label: 'Token/cost/time' },
  ];

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pipeline debug: ${escapeHtml(topic)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, sans-serif;
      background: #1a1a2e;
      color: #eee;
      line-height: 1.6;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    .header {
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 2px solid #e63946;
    }
    .header h1 { font-size: 1.5rem; margin: 0 0 0.5rem 0; }
    .header .subtitle { color: #aaa; font-size: 0.9rem; }
    .header a { color: #6df4a1; text-decoration: none; }
    .header a:hover { text-decoration: underline; }
    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 2rem;
      padding: 1rem;
      background: #252540;
      border-radius: 8px;
    }
    .nav a {
      color: #6df4a1;
      text-decoration: none;
      font-size: 0.9rem;
    }
    .nav a:hover { text-decoration: underline; }
    section {
      margin-bottom: 2.5rem;
      padding: 1.25rem;
      background: #252540;
      border-radius: 8px;
    }
    section h2 {
      font-size: 1.1rem;
      margin: 0 0 1rem 0;
      color: #fff;
    }
    .section-toggle {
      cursor: pointer;
      user-select: none;
    }
    .section-toggle::before { content: '▼ '; font-size: 0.7em; }
    .section-toggle.collapsed::before { content: '▶ '; }
    .section-content.collapsed { display: none; }
    ul { margin: 0.5rem 0; padding-left: 1.5rem; }
    li { margin: 0.25rem 0; }
    a { color: #6df4a1; }
    a:hover { text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #444; }
    th { color: #aaa; font-weight: 500; }
    .count { font-weight: 600; color: #6df4a1; }
    .no-data { color: #888; font-style: italic; }
    .top-refs-list { list-style: decimal; padding-left: 1.5rem; }
    .top-ref-item { margin-bottom: 1.25rem; }
    .top-ref__title { margin: 0 0 0.25rem 0; }
    .top-ref__sentence { margin: 0.25rem 0; font-size: 0.9rem; color: #bbb; line-height: 1.5; }
    .top-ref__meta { margin: 0.25rem 0 0 0; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>Pipeline debug: ${escapeHtml(topic)}</h1>
      <p class="subtitle">
        <a href="../../tabloid_generator/output/${escapeHtml(data.slug)}.html">← Back to article</a>
      </p>
    </header>
    <nav class="nav">
      ${navItems.map((item) => `<a href="#${item.id}">${escapeHtml(item.label)}</a>`).join('\n      ')}
    </nav>
`;

  // Section 1: Arguments & search queries
  html += `
    <section id="arguments">
      <h2 class="section-toggle">Arguments & search queries</h2>
      <div class="section-content">
`;
  if (angles.length > 0) {
    for (const angle of angles) {
      html += `        <p><strong>${escapeHtml(angle.argument ?? '')}</strong></p>\n`;
      const queries = angle.search_queries ?? [];
      if (queries.length > 0) {
        html += `        <ul>\n`;
        for (const query of queries) {
          html += `          <li>${escapeHtml(query)}</li>\n`;
        }
        html += `        </ul>\n`;
      }
    }
  } else {
    html += `        <p class="no-data">No conspiracy data available.</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  // Section 2: Articles per search term
  html += `
    <section id="articles-per-query">
      <h2 class="section-toggle">Articles per search term</h2>
      <div class="section-content">
`;
  const queryEntries = Object.entries(searchQueryArticleTitles);
  if (queryEntries.length > 0) {
    for (const [query, titles] of queryEntries) {
      html += `        <p><strong>${escapeHtml(query)}</strong> (${titles.length})</p>\n        <ul>\n`;
      for (const title of titles) {
        html += `          <li><a href="${escapeHtml(wikiUrl(title))}" target="_blank" rel="noopener">${escapeHtml(title)}</a></li>\n`;
      }
      html += `        </ul>\n`;
    }
  } else {
    html += `        <p class="no-data">No search query data available.</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  // Section 3: Deduped articles
  html += `
    <section id="deduped">
      <h2 class="section-toggle">Deduped articles</h2>
      <div class="section-content">
        <p class="count">${dedupedTitles.length} unique articles</p>
        <ul>
`;
  for (const title of dedupedTitles.slice(0, 50)) {
    html += `          <li><a href="${escapeHtml(wikiUrl(title))}" target="_blank" rel="noopener">${escapeHtml(title)}</a></li>\n`;
  }
  if (dedupedTitles.length > 50) {
    html += `          <li class="no-data">... and ${dedupedTitles.length - 50} more</li>\n`;
  }
  html += `        </ul>\n      </div>\n    </section>\n`;

  // Section 4: After quick filter
  html += `
    <section id="filtered">
      <h2 class="section-toggle">After quick filter</h2>
      <div class="section-content">
        <p class="count">${filteredPages.length} pages</p>
        <ul>
`;
  for (const page of filteredPages) {
    const title = page.title ?? 'Unknown';
    html += `          <li><a href="${escapeHtml(wikiUrl(title))}" target="_blank" rel="noopener">${escapeHtml(title)}</a></li>\n`;
  }
  html += `        </ul>\n      </div>\n    </section>\n`;

  // Section 5: Ref counts
  html += `
    <section id="ref-counts">
      <h2 class="section-toggle">Ref counts</h2>
      <div class="section-content">
`;
  if (refStats) {
    html += `        <table>
          <tr><th>Extracted</th><td>${refStats.extracted ?? 0}</td></tr>
          <tr><th>Retries</th><td>${refStats.retries ?? 0}</td></tr>
          <tr><th>Dead links</th><td>${refStats.deadLinksCount ?? 0}</td></tr>
        </table>
`;
  } else {
    html += `        <p class="no-data">Not available (run pipeline to capture).</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  // Section 5b: Dead links
  const deadLinksList = refStats?.deadLinks ?? [];
  html += `
    <section id="dead-links">
      <h2 class="section-toggle">Dead links</h2>
      <div class="section-content">
`;
  if (deadLinksList.length > 0) {
    html += `        <p class="count">${deadLinksList.length} invalid links</p>
        <ul>
`;
    for (const { url, reason } of deadLinksList) {
      html += `          <li><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a> — ${escapeHtml(reason)}</li>\n`;
    }
    html += `        </ul>\n`;
  } else {
    html += `        <p class="no-data">None (all links passed HEAD check).</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  // Section 6: Top k references
  html += `
    <section id="top-refs">
      <h2 class="section-toggle">Top ${TOP_K_REFS} references</h2>
      <div class="section-content">
`;
  if (topRefs.length > 0) {
    html += `        <ol class="top-refs-list">\n`;
    for (let index = 0; index < topRefs.length; index++) {
      const ref = topRefs[index];
      const refNum = index + 1;
      html += `          <li class="top-ref-item" id="ref-${refNum}">
            <p class="top-ref__title"><strong>[${refNum}]</strong> <a href="${escapeHtml(ref.link)}" target="_blank" rel="noopener">${escapeHtml(ref.title || ref.link)}</a></p>
            ${ref.content ? `<p class="top-ref__sentence">${escapeHtml(ref.content)}</p>` : ''}
            <p class="no-data top-ref__meta">${escapeHtml(ref.articleTitle)} / ${escapeHtml(ref.sectionName)}</p>
          </li>\n`;
    }
    html += `        </ol>\n`;
  } else {
    html += `        <p class="no-data">No extracted references.</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  // Section 7: Token/cost/time
  html += `
    <section id="tokens">
      <h2 class="section-toggle">Token/cost/time</h2>
      <div class="section-content">
`;
  if (stages.length > 0) {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    let totalTime = 0;
    const retriesVal = refStats?.retries ?? 0;
    html += `        <table>
          <thead><tr><th>Stage</th><th>Name</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th><th>Time</th><th>Retries</th></tr></thead>
          <tbody>
`;
    for (const row of stages) {
      totalInput += row.inputTokens ?? 0;
      totalOutput += row.outputTokens ?? 0;
      totalCost += row.cost ?? 0;
      totalTime += row.timeMs ?? 0;
      const cellRetries = row.stage === 4 ? retriesVal : '';
      html += `            <tr>
              <td>${row.stage}/5</td>
              <td>${escapeHtml((row.name ?? '').replace(/\.\.\.$/, ''))}</td>
              <td>${(row.inputTokens ?? 0).toLocaleString()}</td>
              <td>${(row.outputTokens ?? 0).toLocaleString()}</td>
              <td>${((row.cost ?? 0) * 100).toFixed(2)}¢</td>
              <td>${formatTime(row.timeMs ?? 0)}</td>
              <td>${cellRetries}</td>
            </tr>
`;
    }
    html += `            <tr style="font-weight: 600;">
              <td>Total</td>
              <td></td>
              <td>${totalInput.toLocaleString()}</td>
              <td>${totalOutput.toLocaleString()}</td>
              <td>${(totalCost * 100).toFixed(2)}¢</td>
              <td>${formatTime(totalTime)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
`;
  } else {
    html += `        <p class="no-data">Not available (run pipeline to capture).</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  html += `
  </div>
  <script id="debug-data" type="application/json">${JSON.stringify(data)}</script>
  <script>
    document.querySelectorAll('.section-toggle').forEach(function(toggle) {
      toggle.addEventListener('click', function() {
        const content = this.nextElementSibling;
        content.classList.toggle('collapsed');
        this.classList.toggle('collapsed');
      });
    });
  </script>
</body>
</html>
`;

  return html;
}

async function main() {
  const slug = process.argv[2]?.trim();
  if (!slug) {
    console.error('Usage: node imright/scripts/generate-debug.js <slug>');
    console.error('Example: node imright/scripts/generate-debug.js wireless-headphones-can-give-you-brain-cancer');
    process.exit(1);
  }

  const conspiracy = loadConspiracy(slug);
  const wikisFetched = loadYaml(`wiki_searcher/wikis-fetched/${slug}.yaml`);
  const wikisFiltered = loadYaml(`wiki_filterer/wikis-filtered/${slug}.yaml`);
  const extracted = loadYaml(`ref_extractor/extracted/${slug}.yaml`);
  const runStats = loadJson(`run-stats/${slug}.json`);

  const data = {
    slug,
    conspiracy,
    wikisFetched,
    wikisFiltered,
    extracted,
    runStats,
  };

  const html = buildHtml(data);

  const outputPath = path.join(PROJECT_ROOT, 'imright', 'debug', `${slug}.html`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
