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

function loadRawText(relativePath) {
  const fullPath = path.join(PROJECT_ROOT, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
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

/** Flatten extracted (search term -> citations) into deduped list. */
function flattenExtracted(extracted) {
  const seen = new Set();
  const citations = [];
  for (const searchTerm of Object.keys(extracted ?? {})) {
    const items = extracted[searchTerm];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const link = item?.link;
      const title = item?.title ?? '';
      const content = cleanSentence(item?.content ?? '');
      const key = link + '|' + title;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({ link, title, content, searchTerm });
    }
  }
  return citations;
}

/** Extract used ref IDs from text containing [phrase](id) markdown. */
function extractUsedRefIdsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const ids = [];
  const regex = /\[[^\]]*\]\((\d+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ids.push(parseInt(match[1], 10));
  }
  return ids;
}

/** Parse tabloid raw output to get article structure and used ref IDs. */
function parseTabloidArticle(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return null;
  let content = rawOutput.trim();
  const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (codeBlockMatch) content = codeBlockMatch[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const article = parsed?.article ?? parsed;
  if (!article) return null;

  const allUsedRefIds = new Set();

  const extractFromParagraph = (paragraph) => {
    const rawText = typeof paragraph === 'string' ? paragraph : paragraph?.text ?? '';
    for (const id of extractUsedRefIdsFromText(rawText)) {
      allUsedRefIds.add(id);
    }
  };

  const intro = article.intro;
  const introUsedRefIds = [];
  if (intro) {
    const introParagraphs = Array.isArray(intro) ? intro : [intro];
    for (const paragraph of introParagraphs) {
      const rawText = typeof paragraph === 'string' ? paragraph : paragraph?.text ?? '';
      for (const id of extractUsedRefIdsFromText(rawText)) {
        introUsedRefIds.push(id);
        allUsedRefIds.add(id);
      }
    }
  }

  const sections = (article.sections ?? []).map((section) => {
    const heading = section.heading ?? '';
    const usedRefIds = [];
    for (const paragraph of section.paragraphs ?? []) {
      for (const id of extractUsedRefIdsFromText(
        typeof paragraph === 'string' ? paragraph : paragraph?.text ?? ''
      )) {
        usedRefIds.push(id);
        allUsedRefIds.add(id);
      }
    }
    return { heading, usedRefIds };
  });

  const conclusion = article.conclusion;
  const conclusionUsedRefIds = [];
  if (conclusion) {
    const conclusionParagraphs = Array.isArray(conclusion) ? conclusion : [conclusion];
    for (const paragraph of conclusionParagraphs) {
      const rawText = typeof paragraph === 'string' ? paragraph : paragraph?.text ?? '';
      for (const id of extractUsedRefIdsFromText(rawText)) {
        conclusionUsedRefIds.push(id);
        allUsedRefIds.add(id);
      }
    }
  }

  return {
    sections,
    introUsedRefIds,
    conclusionUsedRefIds,
    allUsedRefIds: Array.from(allUsedRefIds),
  };
}

/** Parse conspirator raw output: angles (argument + search_queries). When keep is absent, treat as kept. */
function parseConspiratorOutput(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return null;
  let content = rawOutput.trim();
  const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (codeBlockMatch) content = codeBlockMatch[1].trim();
  try {
    const parsed = JSON.parse(content);
    const arr = Array.isArray(parsed) ? parsed : parsed?.angles ?? [];
    return arr.map((item) => ({
      argument: item.argument ?? '',
      search_queries: item.search_queries ?? [],
      keep: item.keep !== false,
      filtering_thought: item.filtering_thought ?? null,
    }));
  } catch {
    return null;
  }
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
  const tabloidArticle = parseTabloidArticle(data.tabloidRawOutput);
  const usedRefIdsSet = new Set(tabloidArticle?.allUsedRefIds ?? []);
  const conspiratorArgCount = angles.length;
  const conspiratorSearchTermCount = [
    ...new Set(angles.flatMap((a) => a.search_queries ?? [])),
  ].length;
  const tabloidSectionCount = tabloidArticle?.sections?.length ?? 0;
  const tabloidLinkCount = usedRefIdsSet.size;
  const searchQueryArticleTitles = wikisFetched?.search_query_article_titles ?? wikisFiltered?.search_query_article_titles ?? {};
  const dedupedTitles = dedupedArticles(searchQueryArticleTitles);
  const filteredPages = wikisFiltered?.pages ?? [];
  const filteredTitlesSet = new Set((wikisFiltered?.pages ?? []).map((p) => p?.title).filter(Boolean));
  const stages = runStats?.stages ?? [];
  const refStats = runStats?.refStats;
  const deadLinksList = refStats?.deadLinks ?? [];

  /** Build refs per term: merge valid (from extracted) + dead (from runStats), sorted by rank. */
  function buildRefsPerTerm() {
    const byTerm = {};
    for (const searchTerm of Object.keys(extracted ?? {})) {
      const items = extracted[searchTerm];
      if (!Array.isArray(items)) continue;
      const refs = items.map((item) => ({
        ...item,
        rank: item.rank ?? 999,
        dead: false,
      }));
      const deadForTerm = deadLinksList.filter((d) => d.searchTerm === searchTerm);
      for (const d of deadForTerm) {
        refs.push({ link: d.url, title: d.title ?? d.url, content: d.content ?? '', rank: d.rank ?? 999, dead: true, deadReason: d.reason });
      }
      refs.sort((a, b) => a.rank - b.rank);
      byTerm[searchTerm] = refs;
    }
    const orphanDead = deadLinksList.filter((d) => !d.searchTerm);
    if (orphanDead.length > 0) {
      byTerm['Dead links (term unknown)'] = orphanDead.map((d, i) => ({
        link: d.url,
        title: d.title ?? d.url,
        content: d.content ?? '',
        rank: i + 1,
        dead: true,
        deadReason: d.reason,
      }));
    }
    return byTerm;
  }

  const refsPerTerm = buildRefsPerTerm();
  const allValidRefs = flattenExtracted(extracted);
  const urlToRefNum = new Map();
  allValidRefs.slice(0, TOP_K_REFS).forEach((ref, index) => {
    if (ref.link && !urlToRefNum.has(ref.link)) urlToRefNum.set(ref.link, index + 1);
  });

  /** Build refNum -> citation for used-ref lookup (1-based). */
  const refNumToCitation = new Map();
  allValidRefs.slice(0, TOP_K_REFS).forEach((ref, index) => {
    refNumToCitation.set(index + 1, ref);
  });

  const linkStats = data.linkStats;
  const conspiratorRawInput = data.conspiratorRawInput;
  const conspiratorRawOutput = data.conspiratorRawOutput;
  const tabloidRawInput = data.tabloidRawInput;
  const tabloidRawOutput = data.tabloidRawOutput;
  const counterarguerRawInput = data.counterarguerRawInput;
  const counterarguerRawOutput = data.counterarguerRawOutput;

  const validCount = (linkStats?.results ?? []).filter((r) => r.linkStatus === 'probably_valid').length;
  const whitelistedCount = (linkStats?.results ?? []).filter((r) => r.linkStatus === 'whitelisted').length;
  const validationChecks = linkStats?.linkCount ?? linkStats?.results?.length ?? 0;
  const validLinksCount = validCount + whitelistedCount;
  const rawExtractedCount = linkStats?.rawExtractedCount ?? null;

  const conspiratorStage = stages.find((s) => s.stage === 1);
  const tabloidStage = stages.find((s) => s.stage === 5);

  const navItems = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'conspirator',
      label: `Conspirator (${conspiratorArgCount} arguments, ${conspiratorSearchTermCount} search terms)`,
    },
    {
      id: 'articles-found',
      label: `Articles found (${dedupedTitles.length} unique, ${filteredTitlesSet.size} kept)`,
    },
    {
      id: 'link-validation',
      label: `Link validation (${rawExtractedCount ?? '—'} total, ${validationChecks} checked, ${validLinksCount} valid)`,
    },
    { id: 'references', label: `References (${validLinksCount})` },
    {
      id: 'tabloid',
      label: `Tabloid (${tabloidSectionCount} sections, ${tabloidLinkCount} links)`,
    },
    {
      id: 'counterarguer',
      label: `Counterarguer (Bunky) ${counterarguerRawInput?.sections?.length ?? 0} sections`,
    },
    { id: 'stats', label: 'Stats' },
  ];

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pipeline debug: ${escapeHtml(topic)}</title>
  <style>
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
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
    .process-blurb {
      margin: 0 0 2rem 0;
      padding: 1.25rem 1.5rem;
      background: linear-gradient(135deg, #252540 0%, #2d2d4a 100%);
      border-left: 3px solid #6df4a1;
      border-radius: 8px;
      color: #cfd0d8;
      font-size: 0.92rem;
      line-height: 1.6;
    }
    .process-blurb p { margin: 0 0 0.5rem 0; }
    .process-blurb p:last-child { margin-bottom: 0; }
    .process-blurb ol {
      margin: 0.5rem 0 0.5rem 1.25rem;
      padding: 0;
    }
    .process-blurb li { margin: 0.2rem 0; }
    .section-blurb {
      margin: 0 0 1rem 0;
      padding: 0.65rem 0.9rem;
      background: #1a1a2e;
      border-left: 2px solid #6df4a1;
      border-radius: 4px;
      color: #c0c0cc;
      font-size: 0.85rem;
      line-height: 1.5;
    }
    .debug-footer {
      margin-top: 2.5rem;
      padding: 1.25rem 0;
      border-top: 1px solid #3a3a5a;
      text-align: center;
      color: #7a7a8a;
      font-size: 0.8rem;
    }
    .debug-footer p { margin: 0 0 0.35rem 0; }
    .debug-footer p:last-child { margin-bottom: 0; }
    .debug-footer a { color: #6df4a1; text-decoration: none; }
    .debug-footer a:hover { text-decoration: underline; }
    .nav {
      margin-bottom: 2rem;
      padding: 1.25rem 1.5rem;
      background: linear-gradient(135deg, #252540 0%, #2d2d4a 100%);
      border-radius: 12px;
      border: 1px solid #3a3a5a;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    .nav > ul {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 0.5rem;
    }
    .nav li {
      margin: 0;
    }
    .nav a {
      display: block;
      padding: 0.5rem 0.75rem;
      color: #6df4a1;
      text-decoration: none;
      font-size: 0.9rem;
      border-radius: 6px;
      transition: background 0.15s, color 0.15s;
    }
    .nav a:hover {
      background: rgba(109, 244, 161, 0.1);
      color: #7effb3;
    }
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
    .ref-dead { color: #e63946; }
    .ref-used { color: #6df4a1; font-size: 0.85em; }
    .ref-forbidden { color: #f4a261; }
    .article-kept { color: #6df4a1; }
    .ref-timeout { color: #e9c46a; }
    .ref-whitelisted { color: #9b59b6; }
    .term-toggle, .ref-toggle { cursor: pointer; user-select: none; }
    .term-toggle::before { content: '▼ '; font-size: 0.7em; }
    .term-toggle.collapsed::before { content: '▶ '; }
    .ref-toggle::before { content: '▼ '; font-size: 0.7em; }
    .ref-toggle.collapsed::before { content: '▶ '; }
    .term-content.collapsed, .ref-details.collapsed { display: none; }
    .link-stats-table tr:not(.link-stat-details) td { text-align: right; }
    .link-stats-table tr.link-stat-toggle { cursor: pointer; user-select: none; }
    .link-stats-table tr.link-stat-toggle th::before { content: '▼ '; font-size: 0.7em; }
    .link-stats-table tr.link-stat-toggle.collapsed th::before { content: '▶ '; }
    .link-stat-details.collapsed { display: none; }
    .ref-item { margin: 0.5rem 0; padding: 0.5rem; background: #1a1a2e; border-radius: 4px; }
    .grok-pre {
      margin: 0;
      padding: 1rem;
      overflow-x: auto;
      font-family: ui-monospace, "Cascadia Code", "Source Code Pro", monospace;
      font-size: 0.8rem;
      line-height: 1.4;
      background: #0d0d14;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 30rem;
      overflow-y: auto;
    }
    .overview-panes {
      display: flex;
      gap: 2rem;
      position: relative;
      min-height: 200px;
      padding-bottom: 1rem;
    }
    .overview-pane {
      flex: 1;
      min-width: 0;
    }
    .overview-pane h3 { font-size: 0.95rem; margin: 0 0 0.5rem 0; color: #aaa; }
    .overview-arg { margin-bottom: 1rem; }
    .overview-arg-title { font-weight: 600; margin-bottom: 0.25rem; font-size: 0.9rem; }
    .overview-arg-badge { font-size: 0.75em; padding: 0.1em 0.4em; border-radius: 3px; margin-left: 0.5em; }
    .overview-arg-badge.kept { background: #2d4a2d; color: #6df4a1; }
    .overview-arg-badge.filtered { background: #4a2d2d; color: #e63946; }
    .overview-term { margin-left: 1rem; margin-bottom: 0.5rem; font-size: 0.85rem; }
    .overview-term-title { color: #bbb; margin-bottom: 0.25rem; }
    .overview-ref a { color: #6df4a1; }
    .overview-ref {
      margin-left: 1.5rem;
      font-size: 0.8rem;
      padding: 0.2rem 0;
      position: relative;
    }
    .overview-ref .overview-ref-tooltip {
      display: none;
      position: absolute;
      left: 100%;
      top: 0;
      margin-left: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: #0d0d14;
      border: 1px solid #444;
      border-radius: 4px;
      font-size: 0.8rem;
      line-height: 1.4;
      color: #ccc;
      max-width: 320px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 10;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .overview-ref:hover .overview-ref-tooltip {
      display: block;
    }
    #overview-right .overview-ref .overview-ref-tooltip {
      left: auto;
      right: 100%;
      margin-left: 0;
      margin-right: 0.5rem;
    }
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
    <div class="process-blurb">
      <p><strong>How the article got made.</strong> This page shows every stage of the imright.com pipeline for the claim above. The pipeline turns a one-line conspiracy into a fully-cited tabloid article by mining Wikipedia and letting Grok stitch the pieces together:</p>
      <ol>
        <li><strong>Conspirator</strong> brainstorms bad-faith angles supporting the claim and generates Wikipedia search queries for each.</li>
        <li><strong>Wiki searcher</strong> runs every query against Wikipedia and collects candidate article titles.</li>
        <li><strong>Wiki filterer</strong> keeps only the pages that could plausibly back the narrative and drops the rest.</li>
        <li><strong>Ref extractor</strong> pulls sentences with citation links from the kept pages and validates that each outbound link actually resolves.</li>
        <li><strong>Tabloid generator</strong> asks Grok to write a tabloid-style article grounded in those verified citations.</li>
        <li><strong>Pixabay images</strong> are fetched for the hero and each section, then the HTML is assembled.</li>
        <li><strong>Counterarguer (Bunky)</strong> reads the finished article and writes a per-section rebuttal so you can see what's being left out.</li>
      </ol>
      <p>Each section below exposes the raw inputs and outputs at that stage.</p>
    </div>
    <nav class="nav">
      <ul>
        ${navItems.map((item) => `<li><a href="#${item.id}">${escapeHtml(item.label)}</a></li>`).join('\n        ')}
      </ul>
    </nav>
`;

  // Section: Overview (two-pane waterfall)
  const overviewArgs = parseConspiratorOutput(conspiratorRawOutput) ?? angles.map((a) => ({
    argument: a.argument ?? '',
    search_queries: a.search_queries ?? [],
    keep: true,
  }));
  const overviewSectionId = 'overview';
  html += `
    <section id="${overviewSectionId}">
      <h2 class="section-toggle">Overview</h2>
      <div class="section-content">
        <p class="section-blurb">Side-by-side waterfall: on the left, every argument the Conspirator proposed with the Wikipedia search terms it generated and the references those terms turned up. On the right, the final tabloid article broken into the final arguments it landed on based on the "evidence" it was able to find, listing the references it ended up citing. Hover a reference to see its excerpt.</p>
        <div class="overview-panes" id="overview-panes">
          <div class="overview-pane" id="overview-left">
            <h3>Original arguments</h3>
`;
  for (let argIdx = 0; argIdx < overviewArgs.length; argIdx++) {
    const overviewArg = overviewArgs[argIdx];
    const badge = overviewArg.keep
      ? '<span class="overview-arg-badge kept">KEPT</span>'
      : '<span class="overview-arg-badge filtered">FILTERED</span>';
    html += `            <div class="overview-arg">
              <div class="overview-arg-title">${escapeHtml(overviewArg.argument)}${badge}</div>
`;
    for (let termIdx = 0; termIdx < (overviewArg.search_queries ?? []).length; termIdx++) {
      const searchTerm = overviewArg.search_queries[termIdx];
      const refs = refsPerTerm[searchTerm] ?? [];
      const validCount = refs.filter((r) => !r.dead).length;
      const usedCount = refs.filter(
        (r) => !r.dead && usedRefIdsSet.has(urlToRefNum.get(r.link))
      ).length;
      const countsLabel =
        refs.length > 0
          ? `(${refs.length} refs, ${validCount} valid, ${usedCount} used)`
          : '(not searched)';
      html += `              <div class="overview-term">
                <div class="overview-term-title">${escapeHtml(searchTerm)} ${countsLabel}</div>
`;
      for (const ref of refs) {
        const refNum = ref.dead ? null : urlToRefNum.get(ref.link);
        const titleDisplay = ref.dead ? escapeHtml(ref.link) : escapeHtml(ref.title || ref.link);
        const deadBadge = ref.dead ? ` <span class="ref-dead">DEAD</span>` : '';
        const usedBadge =
          refNum != null && usedRefIdsSet.has(refNum)
            ? ' <span class="ref-used">USED</span>'
            : '';
        const tooltipContent = escapeHtml(ref.content || 'No excerpt.');
        html += `                <div class="overview-ref">${refNum != null ? `[${refNum}] ` : ''}<a href="${escapeHtml(ref.link ?? '#')}" target="_blank" rel="noopener">${titleDisplay}</a>${deadBadge}${usedBadge}<span class="overview-ref-tooltip">${tooltipContent}</span></div>
`;
      }
      html += `              </div>
`;
    }
    html += `            </div>
`;
  }
  html += `          </div>
          <div class="overview-pane" id="overview-right">
            <h3>Final arguments</h3>
`;
  if (tabloidArticle?.introUsedRefIds?.length > 0) {
    const introRefIds = [...new Set(tabloidArticle.introUsedRefIds)];
    html += `            <div class="overview-arg">
              <div class="overview-arg-title">Intro</div>
`;
    for (const refNum of introRefIds) {
      const citation = refNumToCitation.get(refNum);
      const titleDisplay = citation
        ? escapeHtml(citation.title || citation.link)
        : `Ref ${refNum}`;
      const tooltipContent = citation?.content ? escapeHtml(citation.content) : 'No excerpt.';
      html += `              <div class="overview-ref">[${refNum}] <a href="${citation ? escapeHtml(citation.link) : '#'}" target="_blank" rel="noopener">${titleDisplay}</a><span class="overview-ref-tooltip">${tooltipContent}</span></div>
`;
    }
    html += `            </div>
`;
  }
  for (const section of tabloidArticle?.sections ?? []) {
    const usedRefIds = [...new Set(section.usedRefIds ?? [])];
    if (usedRefIds.length === 0) continue;
    html += `            <div class="overview-arg">
              <div class="overview-arg-title">${escapeHtml(section.heading)}</div>
`;
    for (const refNum of usedRefIds) {
      const citation = refNumToCitation.get(refNum);
      const titleDisplay = citation
        ? escapeHtml(citation.title || citation.link)
        : `Ref ${refNum}`;
      const tooltipContent = citation?.content ? escapeHtml(citation.content) : 'No excerpt.';
      html += `              <div class="overview-ref">[${refNum}] <a href="${citation ? escapeHtml(citation.link) : '#'}" target="_blank" rel="noopener">${titleDisplay}</a><span class="overview-ref-tooltip">${tooltipContent}</span></div>
`;
    }
    html += `            </div>
`;
  }
  if (tabloidArticle?.conclusionUsedRefIds?.length > 0) {
    const conclusionRefIds = [...new Set(tabloidArticle.conclusionUsedRefIds)];
    html += `            <div class="overview-arg">
              <div class="overview-arg-title">Conclusion</div>
`;
    for (const refNum of conclusionRefIds) {
      const citation = refNumToCitation.get(refNum);
      const titleDisplay = citation
        ? escapeHtml(citation.title || citation.link)
        : `Ref ${refNum}`;
      const tooltipContent = citation?.content ? escapeHtml(citation.content) : 'No excerpt.';
      html += `              <div class="overview-ref">[${refNum}] <a href="${citation ? escapeHtml(citation.link) : '#'}" target="_blank" rel="noopener">${titleDisplay}</a><span class="overview-ref-tooltip">${tooltipContent}</span></div>
`;
    }
    html += `            </div>
`;
  }
  html += `          </div>
        </div>
      </div>
    </section>
`;

  /** Format message content for display: preserve newlines, pretty-print JSON when detectable. */
  function formatMessageContent(content) {
    if (!content || typeof content !== 'string') return '';
    const trimmed = content.trim();
    if (!trimmed) return '';
    const jsonMatch = trimmed.match(/\n\nAngles to filter:\s*\n([\s\S]*)$/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        const pretty = JSON.stringify(parsed, null, 2);
        const before = trimmed.slice(0, jsonMatch.index) + '\n\nAngles to filter:\n';
        return escapeHtml(before + pretty);
      } catch {
        // Fall through to plain escape
      }
    }
    return escapeHtml(content);
  }

  // Section: Conspirator (Input + Output)
  const conspiratorInputTokens = conspiratorStage?.inputTokens ?? 0;
  const conspiratorOutputTokens = conspiratorStage?.outputTokens ?? 0;
  html += `
    <section id="conspirator">
      <h2 class="section-toggle">Conspirator (${conspiratorArgCount} arguments, ${conspiratorSearchTermCount} search terms)</h2>
      <div class="section-content">
        <p class="section-blurb">Stage 1. Grok takes the claim and brainstorms several bad-faith arguments that would defend it, then emits a set of Wikipedia search queries per argument for the next stage to run. Includes the raw prompt, raw response, and the parsed argument tree.</p>
        <div class="ref-item">
          <div class="term-toggle collapsed">Input (${conspiratorInputTokens} tokens)</div>
          <div class="term-content collapsed">
`;
  if (conspiratorRawInput) {
    const anglesMessages = conspiratorRawInput.angles ?? [];
    html += `            <div class="ref-item">
              <div class="term-toggle collapsed">angles</div>
              <div class="term-content collapsed">
`;
    for (let idx = 0; idx < anglesMessages.length; idx++) {
      const msg = anglesMessages[idx];
      const role = msg?.role ?? 'unknown';
      const content = msg?.content ?? '';
      html += `                <div class="ref-item">
                  <div class="term-toggle collapsed">${escapeHtml(role)}</div>
                  <div class="term-content collapsed">
                    <pre class="grok-pre">${formatMessageContent(content)}</pre>
                  </div>
                </div>
`;
    }
    html += `              </div>
            </div>
`;
  } else {
    html += `            <p class="no-data">No raw input (re-run pipeline to capture).</p>\n`;
  }
  html += `          </div>
        </div>
        <div class="ref-item">
          <div class="term-toggle collapsed">Output (${conspiratorOutputTokens} tokens)</div>
          <div class="term-content collapsed">
`;
  if (conspiratorRawOutput) {
    let outputFormatted = conspiratorRawOutput;
    try {
      let content = conspiratorRawOutput.trim();
      const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
      if (codeBlockMatch) content = codeBlockMatch[1].trim();
      const parsed = JSON.parse(content);
      outputFormatted = JSON.stringify(parsed, null, 2);
    } catch {
      // Keep as-is (plain text)
    }
    html += `            <pre class="grok-pre">${escapeHtml(outputFormatted)}</pre>\n`;
  } else {
    html += `            <p class="no-data">No raw output (re-run pipeline to capture).</p>\n`;
  }
  html += `          </div>
        </div>
        <div class="ref-item">
          <div class="term-toggle">Arguments</div>
          <div class="term-content">
`;
  if (angles.length > 0) {
    for (const angle of angles) {
      html += `            <p><strong>${escapeHtml(angle.argument ?? '')}</strong></p>\n`;
      const queries = angle.search_queries ?? [];
      if (queries.length > 0) {
        html += `            <ul>\n`;
        for (const query of queries) {
          html += `              <li>${escapeHtml(query)}</li>\n`;
        }
        html += `            </ul>\n`;
      }
    }
  } else {
    html += `            <p class="no-data">No conspiracy data available.</p>\n`;
  }
  html += `          </div>
        </div>
      </div>
    </section>
`;

  // Section: Articles found (per term + full deduped list)
  const titleToQueries = new Map();
  for (const [query, titles] of Object.entries(searchQueryArticleTitles)) {
    for (const title of titles ?? []) {
      if (!titleToQueries.has(title)) titleToQueries.set(title, []);
      titleToQueries.get(title).push(query);
    }
  }
  html += `
    <section id="articles-found">
      <h2 class="section-toggle collapsed">Articles found (${dedupedTitles.length} unique, ${filteredTitlesSet.size} kept)</h2>
      <div class="section-content collapsed">
        <p class="section-blurb">Stages 2 and 3. Every Wikipedia article that came back from the Conspirator's search queries, grouped by which query surfaced it. Pages the Wiki filterer judged irrelevant are marked "filtered out"; the rest move on to citation extraction.</p>
        <div class="ref-item">
          <div class="term-toggle">Listed per search term</div>
          <div class="term-content">
`;
  const queryEntries = Object.entries(searchQueryArticleTitles);
  if (queryEntries.length > 0) {
    for (const [query, titles] of queryEntries) {
      html += `            <p><strong>${escapeHtml(query)}</strong> (${(titles ?? []).length})</p>\n            <ul>\n`;
      for (const title of titles ?? []) {
        html += `              <li><a href="${escapeHtml(wikiUrl(title))}" target="_blank" rel="noopener">${escapeHtml(title)}</a></li>\n`;
      }
      html += `            </ul>\n`;
    }
  } else {
    html += `            <p class="no-data">No search query data available.</p>\n`;
  }
  html += `          </div>
        </div>
        <div class="ref-item">
          <div class="term-toggle collapsed">Full list</div>
          <div class="term-content collapsed">
            <p class="count">${dedupedTitles.length} unique articles, ${filteredTitlesSet.size} kept</p>
            <ul class="deduped-list">
`;
  for (const title of dedupedTitles) {
    const queries = titleToQueries.get(title) ?? [];
    const termsLabel = queries.length > 0 ? ` [${queries.map((q) => escapeHtml(q)).join(', ')}]` : '';
    const filteredOut = !filteredTitlesSet.has(title);
    const statusLabel = filteredOut ? ' <span class="ref-dead">filtered out</span>' : ' <span class="article-kept">kept</span>';
    html += `              <li><a href="${escapeHtml(wikiUrl(title))}" target="_blank" rel="noopener">${escapeHtml(title)}</a>${termsLabel}${statusLabel}</li>\n`;
  }
  html += `            </ul>
          </div>
        </div>
      </div>
    </section>
`;

  // Section: Link validation stats (merged with ref counts, above References)
  const invalidCount = (linkStats?.results ?? []).filter((r) => r.linkStatus === 'invalid').length;
  const forbiddenCount = (linkStats?.results ?? []).filter(
    (r) => r.linkStatus === 'forbidden' || r.linkStatus === 'unknown'
  ).length;
  const timeoutCount = (linkStats?.results ?? []).filter((r) => r.linkStatus === 'timeout').length;
  const effectiveTimeMs = linkStats?.effectiveTimeMs ?? null;
  const retries = refStats?.retries ?? 0;

  html += `
    <section id="link-validation">
      <h2 class="section-toggle">Link validation (${rawExtractedCount ?? '—'} total, ${validationChecks} checked, ${validLinksCount} valid)</h2>
      <div class="section-content">
        <p class="section-blurb">Part of stage 4. Every outbound citation link the Ref extractor pulled off a Wikipedia page is HEAD-checked (with a whitelist for known-good domains). Dead, forbidden, or timed-out links are dropped before Grok ever sees them, so the tabloid won't cite anything that 404s.</p>
`;
  if (linkStats?.results?.length > 0 || refStats) {
    const rawDisplay = rawExtractedCount != null ? rawExtractedCount : '—';
    const totalTimeDisplay = effectiveTimeMs != null ? formatTime(effectiveTimeMs) : (linkStats?.totalTimeMs != null ? formatTime(linkStats.totalTimeMs) : '—');

    html += `        <table class="link-stats-table">
          <tr><th>Raw extracted</th><td>${rawDisplay}</td></tr>
          <tr><th>Links to validate</th><td>${validationChecks}</td></tr>
          <tr class="link-stat-toggle collapsed">
            <th>Valid links</th>
            <td>${validLinksCount}</td>
          </tr>
          <tr class="link-stat-details collapsed">
            <td colspan="2" style="padding-left: 1.5em;">
              <table style="margin: 0; border: none; font-size: 0.9rem;">
                <tr><th style="text-align: left;">Valid</th><td style="text-align: right;">${validCount}</td></tr>
                <tr><th style="text-align: left;">Invalid</th><td style="text-align: right;">${invalidCount}</td></tr>
                <tr><th style="text-align: left;">Forbidden</th><td style="text-align: right;">${forbiddenCount}</td></tr>
                <tr><th style="text-align: left;">Whitelisted</th><td style="text-align: right;">${whitelistedCount}</td></tr>
                <tr><th style="text-align: left;">Timeout</th><td style="text-align: right;">${timeoutCount}</td></tr>
              </table>
            </td>
          </tr>
          <tr class="link-stat-toggle collapsed">
            <th>Total time</th>
            <td>${totalTimeDisplay}</td>
          </tr>
          <tr class="link-stat-details collapsed">
            <td colspan="2" style="padding-left: 1.5em;">
`;
    if (linkStats?.results?.length > 0) {
      const totalTimeMs = linkStats.totalTimeMs ?? linkStats.results.reduce((sum, r) => sum + (r.timeMs ?? 0), 0);
      const avgMs = linkStats.averageTimeMs ?? 0;
      const medMs = linkStats.medianTimeMs ?? 0;
      const allTimes = (linkStats.results ?? []).map((r) => r.timeMs ?? 0).filter((t) => t > 0);
      const maxMs = allTimes.length ? Math.max(...allTimes) : 0;
      const validTimes = (linkStats.results ?? []).filter((r) => r.linkStatus === 'probably_valid').map((r) => r.timeMs ?? 0).filter((t) => t > 0);
      const maxValidMs = validTimes.length ? Math.max(...validTimes) : 0;
      html += `        <table style="margin: 0; border: none; font-size: 0.9rem;">
          <tr><th style="text-align: left;">Retries</th><td style="text-align: right;">${retries}</td></tr>
          <tr><th style="text-align: left;">Average per link</th><td style="text-align: right;">${formatTime(avgMs)}</td></tr>
          <tr><th style="text-align: left;">Median</th><td style="text-align: right;">${formatTime(medMs)}</td></tr>
          <tr><th style="text-align: left;">Max</th><td style="text-align: right;">${formatTime(maxMs)}</td></tr>
          <tr><th style="text-align: left;">Max valid time</th><td style="text-align: right;">${formatTime(maxValidMs)}</td></tr>
        </table>
`;
    }
    html += `            </td>
          </tr>
        </table>
`;
    if (linkStats?.results?.length > 0) {
      html += `        <div class="ref-item" style="margin-top: 1rem;">
          <div class="term-toggle collapsed">Full results</div>
          <div class="term-content collapsed">
            <div class="link-results-list">
`;
      linkStats.results.forEach((result, index) => {
        const statusClass =
          result.linkStatus === 'invalid'
            ? 'ref-dead'
            : result.linkStatus === 'probably_valid'
              ? ''
              : result.linkStatus === 'whitelisted'
                ? 'ref-whitelisted'
                : result.linkStatus === 'timeout'
                  ? 'ref-timeout'
                  : 'ref-forbidden';
        const statusLabel =
          result.linkStatus === 'invalid'
            ? 'INVALID'
            : result.linkStatus === 'probably_valid'
              ? 'OK'
              : result.linkStatus === 'whitelisted'
                ? 'WHITELISTED'
                : result.linkStatus === 'timeout'
                  ? 'TIMEOUT'
                  : 'FORBIDDEN';
        html += `
          <div class="ref-item">
            <div class="ref-toggle collapsed">
              <strong>${index + 1}.</strong> <a href="${escapeHtml(result.url)}" target="_blank" rel="noopener">${escapeHtml(result.url)}</a>
              <span class="${statusClass}">${statusLabel}</span>
              ${result.detail ? ` — ${escapeHtml(result.detail)}` : ''}
              — ${formatTime(result.timeMs ?? 0)}
            </div>
            <div class="ref-details collapsed">
              <p><strong>URL:</strong> <a href="${escapeHtml(result.url)}" target="_blank" rel="noopener">${escapeHtml(result.url)}</a></p>
              <p><strong>Status:</strong> ${escapeHtml(result.linkStatus ?? '')}</p>
              ${result.issueType ? `<p><strong>Issue type:</strong> ${escapeHtml(result.issueType)}</p>` : ''}
              ${result.detail ? `<p><strong>Detail:</strong> ${escapeHtml(result.detail)}</p>` : ''}
              <p><strong>Time:</strong> ${formatTime(result.timeMs ?? 0)}</p>
              ${result.round ? `<p><strong>Round:</strong> ${result.round}</p>` : ''}
            </div>
          </div>
`;
      });
      html += `            </div>
          </div>
        </div>
`;
    }
  } else {
    html += `        <p class="no-data">No link validation data (run pipeline with link check enabled).</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  // Section: References (argument -> search term -> ref)
  html += `
    <section id="references">
      <h2 class="section-toggle">References (${validLinksCount})</h2>
      <div class="section-content">
        <p class="section-blurb">Rest of stage 4. The surviving citations, grouped by argument and then by search term. Each entry shows the sentence excerpt the Ref extractor pulled from Wikipedia; items tagged "USED" are ones the tabloid article actually linked to.</p>
`;
  const searchTermsShown = new Set();

  function renderRefsList(refs, termIndex, termKey) {
    let refsHtml = '';
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index];
      const refNum = ref.dead ? null : urlToRefNum.get(ref.link);
      const refId = refNum ? `ref-${refNum}` : `ref-${termKey}-${termIndex}-${index}`;
      const titleDisplay = ref.dead ? escapeHtml(ref.link) : escapeHtml(ref.title || ref.link);
      const deadBadge = ref.dead ? ` <span class="ref-dead">DEAD: ${escapeHtml(ref.deadReason ?? '')}</span>` : '';
      const usedBadge =
        refNum != null && usedRefIdsSet.has(refNum)
          ? ' <span class="ref-used">USED</span>'
          : '';
      const detailsContent = ref.content ? `<p class="top-ref__sentence">${escapeHtml(ref.content)}</p>` : '<p class="no-data">No excerpt.</p>';
      refsHtml += `
            <div class="ref-item">
              <div class="ref-toggle collapsed">
                <strong>${ref.rank}.</strong> ${refNum ? `[${refNum}] ` : ''}<a href="${escapeHtml(ref.link)}" target="_blank" rel="noopener" ${refNum ? `id="${refId}"` : ''}>${titleDisplay}</a>${deadBadge}${usedBadge}
              </div>
              <div class="ref-details collapsed">
                ${detailsContent}
              </div>
            </div>
`;
    }
    return refsHtml;
  }

  if (angles.length > 0 || Object.keys(refsPerTerm).length > 0) {
    for (const angle of angles) {
      const argument = angle.argument ?? '';
      const searchQueries = angle.search_queries ?? [];
      let argTotalRefs = 0;
      let argValidRefs = 0;
      let argUsedRefs = 0;
      for (const query of searchQueries) {
        const refs = refsPerTerm[query] ?? [];
        argTotalRefs += refs.length;
        argValidRefs += refs.filter((r) => !r.dead).length;
        argUsedRefs += refs.filter(
          (r) => !r.dead && usedRefIdsSet.has(urlToRefNum.get(r.link))
        ).length;
        searchTermsShown.add(query);
      }
      if (argTotalRefs === 0) continue;
      const argRefsLabel = argTotalRefs === 1 ? 'ref' : 'refs';
      html += `
        <div class="ref-item">
          <div class="term-toggle collapsed">${escapeHtml(argument)} (${argTotalRefs} ${argRefsLabel}, ${argValidRefs} valid, ${argUsedRefs} used)</div>
          <div class="term-content collapsed">
`;
      for (const searchTerm of searchQueries) {
        const refs = refsPerTerm[searchTerm] ?? [];
        if (refs.length === 0) continue;
        const validRefCount = refs.filter((r) => !r.dead).length;
        const usedRefCount = refs.filter(
          (r) => !r.dead && usedRefIdsSet.has(urlToRefNum.get(r.link))
        ).length;
        const refsLabel = refs.length === 1 ? 'ref' : 'refs';
        html += `
          <div class="ref-item">
            <div class="term-toggle collapsed">${escapeHtml(searchTerm)} (${refs.length} ${refsLabel}, ${validRefCount} valid, ${usedRefCount} used)</div>
            <div class="term-content collapsed">
${renderRefsList(refs, searchQueries.indexOf(searchTerm), searchTerm)}
          </div>
        </div>
`;
      }
      html += `        </div>\n      </div>\n`;
    }

    // Orphan terms not in any angle (e.g. Dead links (term unknown))
    const orphanTerms = Object.keys(refsPerTerm).filter((key) => !searchTermsShown.has(key));
    for (const searchTerm of orphanTerms) {
      const refs = refsPerTerm[searchTerm];
      const validRefCount = refs.filter((r) => !r.dead).length;
      const usedRefCount = refs.filter(
        (r) => !r.dead && usedRefIdsSet.has(urlToRefNum.get(r.link))
      ).length;
      const refsLabel = refs.length === 1 ? 'ref' : 'refs';
      html += `
        <div class="ref-item">
          <div class="term-toggle collapsed">${escapeHtml(searchTerm)} (${refs.length} ${refsLabel}, ${validRefCount} valid, ${usedRefCount} used)</div>
          <div class="term-content collapsed">
${renderRefsList(refs, 0, searchTerm)}
          </div>
        </div>
`;
    }
  } else {
    html += `        <p class="no-data">No extracted references.</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  // Section: Stats (Token/cost/time)
  html += `
    <section id="stats">
      <h2 class="section-toggle">Stats</h2>
      <div class="section-content">
        <p class="section-blurb">Per-stage token consumption, Grok API cost, and wall-clock time. Useful for spotting which stage is dragging or which one burned the most tokens on a given run.</p>
`;
  if (stages.length > 0) {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    let totalTime = 0;
    html += `        <table>
          <thead><tr><th>Stage</th><th>Name</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th><th>Time</th></tr></thead>
          <tbody>
`;
    for (const row of stages) {
      totalInput += row.inputTokens ?? 0;
      totalOutput += row.outputTokens ?? 0;
      totalCost += row.cost ?? 0;
      totalTime += row.timeMs ?? 0;
      html += `            <tr>
              <td>${row.stage}/${stages.length > 0 ? Math.max(...stages.map((s) => s.stage)) : 6}</td>
              <td>${escapeHtml((row.name ?? '').replace(/\.\.\.$/, ''))}</td>
              <td>${(row.inputTokens ?? 0).toLocaleString()}</td>
              <td>${(row.outputTokens ?? 0).toLocaleString()}</td>
              <td>${((row.cost ?? 0) * 100).toFixed(2)}¢</td>
              <td>${formatTime(row.timeMs ?? 0)}</td>
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
            </tr>
          </tbody>
        </table>
`;
  } else {
    html += `        <p class="no-data">Not available (run pipeline to capture).</p>\n`;
  }
  html += `      </div>\n    </section>\n`;

  /** Format tabloid user message: pretty-print the embedded JSON (candidateArguments). */
  function formatTabloidUserContent(content) {
    if (!content || typeof content !== 'string') return '';
    const trimmed = content.trim();
    if (!trimmed) return '';
    const jsonMatch = trimmed.match(/Source material[^\n]*\n([\s\S]*?)(?:\n\n|$)/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        const pretty = JSON.stringify(parsed, null, 2);
        const startOfJson = trimmed.indexOf(jsonMatch[1]);
        const before = trimmed.slice(0, startOfJson);
        const after = trimmed.slice(startOfJson + jsonMatch[1].length);
        return escapeHtml(before + pretty + after);
      } catch {
        // Fall through
      }
    }
    return escapeHtml(content);
  }

  // Section: Tabloid (Input + Output)
  const tabloidInputTokens = tabloidStage?.inputTokens ?? 0;
  const tabloidOutputTokens = tabloidStage?.outputTokens ?? 0;
  html += `
    <section id="tabloid">
      <h2 class="section-toggle">Tabloid (${tabloidSectionCount} sections, ${tabloidLinkCount} links)</h2>
      <div class="section-content">
        <p class="section-blurb">Stage 5. Grok is handed every validated citation (with id, title, and excerpt) and asked to write an intro, body sections, and a conclusion, linking to the supplied sources by id. This section shows the exact prompt sent, the raw JSON article back, and a per-section breakdown of which references ended up in the final piece.</p>
        <div class="ref-item">
          <div class="term-toggle collapsed">Input (${tabloidInputTokens} tokens)</div>
          <div class="term-content collapsed">
`;
  if (tabloidRawInput) {
    const tabloidMessages = tabloidRawInput.messages ?? [];
    for (let idx = 0; idx < tabloidMessages.length; idx++) {
      const msg = tabloidMessages[idx];
      const role = msg?.role ?? 'unknown';
      const content = msg?.content ?? '';
      const formatted =
        role === 'user' ? formatTabloidUserContent(content) : formatMessageContent(content);
      html += `            <div class="ref-item">
              <div class="term-toggle collapsed">${escapeHtml(role)}</div>
              <div class="term-content collapsed">
                <pre class="grok-pre">${formatted}</pre>
              </div>
            </div>
`;
    }
  } else {
    html += `            <p class="no-data">No raw input (re-run pipeline to capture).</p>\n`;
  }
  html += `          </div>
        </div>
        <div class="ref-item">
          <div class="term-toggle collapsed">Output (${tabloidOutputTokens} tokens)</div>
          <div class="term-content collapsed">
`;
  if (tabloidRawOutput) {
    let outputFormatted = tabloidRawOutput;
    try {
      let content = tabloidRawOutput.trim();
      const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
      if (codeBlockMatch) content = codeBlockMatch[1].trim();
      const parsed = JSON.parse(content);
      outputFormatted = JSON.stringify(parsed, null, 2);
    } catch {
      // Keep as-is (plain text)
    }
    html += `            <pre class="grok-pre">${escapeHtml(outputFormatted)}</pre>\n`;
  } else {
    html += `            <p class="no-data">No raw output (re-run pipeline to capture).</p>\n`;
  }
  html += `          </div>
        </div>
`;

  // Tabloid Overview: each section + refs used
  html += `        <div class="ref-item">
          <div class="term-toggle collapsed">Overview</div>
          <div class="term-content collapsed">
`;
  const hasOverview =
    (tabloidArticle?.introUsedRefIds?.length > 0) ||
    (tabloidArticle?.sections?.length > 0) ||
    (tabloidArticle?.conclusionUsedRefIds?.length > 0);
  if (hasOverview) {
    if (tabloidArticle?.introUsedRefIds?.length > 0) {
      const introRefIds = [...new Set(tabloidArticle.introUsedRefIds)];
      const introRefsLabel = introRefIds.length === 1 ? 'ref' : 'refs';
      html += `            <div class="ref-item">
              <div class="term-toggle collapsed">Intro (${introRefIds.length} ${introRefsLabel})</div>
              <div class="term-content collapsed">
`;
      for (const refNum of introRefIds) {
        const citation = refNumToCitation.get(refNum);
        const titleDisplay = citation
          ? escapeHtml(citation.title || citation.link)
          : `Ref ${refNum}`;
        const detailsContent = citation?.content
          ? `<p class="top-ref__sentence">${escapeHtml(citation.content)}</p>`
          : '<p class="no-data">No excerpt.</p>';
        const refId = `overview-ref-${refNum}`;
        html += `                <div class="ref-item">
                  <div class="ref-toggle collapsed">
                    <strong>[${refNum}]</strong> <a href="${citation ? escapeHtml(citation.link) : '#'}" target="_blank" rel="noopener">${titleDisplay}</a>
                  </div>
                  <div class="ref-details collapsed">
                    ${detailsContent}
                  </div>
                </div>
`;
      }
      html += `              </div>
            </div>
`;
    }
    for (const section of tabloidArticle?.sections ?? []) {
      const usedRefIds = [...new Set(section.usedRefIds ?? [])];
      const refsLabel = usedRefIds.length === 1 ? 'ref' : 'refs';
      html += `            <div class="ref-item">
              <div class="term-toggle collapsed">${escapeHtml(section.heading)} (${usedRefIds.length} ${refsLabel})</div>
              <div class="term-content collapsed">
`;
      for (const refNum of usedRefIds) {
        const citation = refNumToCitation.get(refNum);
        const titleDisplay = citation
          ? escapeHtml(citation.title || citation.link)
          : `Ref ${refNum}`;
        const detailsContent = citation?.content
          ? `<p class="top-ref__sentence">${escapeHtml(citation.content)}</p>`
          : '<p class="no-data">No excerpt.</p>';
        const refId = `ref-${refNum}`;
        html += `                <div class="ref-item">
                  <div class="ref-toggle collapsed">
                    <strong>[${refNum}]</strong> <a href="${citation ? escapeHtml(citation.link) : '#'}" target="_blank" rel="noopener" id="${refId}">${titleDisplay}</a>
                  </div>
                  <div class="ref-details collapsed">
                    ${detailsContent}
                  </div>
                </div>
`;
      }
      html += `              </div>
            </div>
`;
    }
    if (tabloidArticle?.conclusionUsedRefIds?.length > 0) {
      const conclusionRefIds = [...new Set(tabloidArticle.conclusionUsedRefIds)];
      const conclusionRefsLabel = conclusionRefIds.length === 1 ? 'ref' : 'refs';
      html += `            <div class="ref-item">
              <div class="term-header">
                <div class="term-toggle collapsed">Conclusion (${conclusionRefIds.length} ${conclusionRefsLabel})</div>
                <span class="term-collapse-btn"><button type="button" class="collapse-expand-all-btn" data-scope="term">Collapse all</button></span>
              </div>
              <div class="term-content collapsed">
`;
      for (const refNum of conclusionRefIds) {
        const citation = refNumToCitation.get(refNum);
        const titleDisplay = citation
          ? escapeHtml(citation.title || citation.link)
          : `Ref ${refNum}`;
        const detailsContent = citation?.content
          ? `<p class="top-ref__sentence">${escapeHtml(citation.content)}</p>`
          : '<p class="no-data">No excerpt.</p>';
        html += `                <div class="ref-item">
                  <div class="ref-toggle collapsed">
                    <strong>[${refNum}]</strong> <a href="${citation ? escapeHtml(citation.link) : '#'}" target="_blank" rel="noopener">${titleDisplay}</a>
                  </div>
                  <div class="ref-details collapsed">
                    ${detailsContent}
                  </div>
                </div>
`;
      }
      html += `              </div>
            </div>
`;
    }
  }
  if (!hasOverview) {
    html += `            <p class="no-data">No article structure (parse output_raw to see sections).</p>\n`;
  }
  html += `          </div>
        </div>
      </div>
    </section>
`;

  // Section: Counterarguer (Bunky input + output)
  const counterarguerStage = stages.find((s) => s.stage === 7);
  const counterarguerInputTokens = counterarguerStage?.inputTokens ?? 0;
  const counterarguerOutputTokens = counterarguerStage?.outputTokens ?? 0;
  const counterarguerSectionCount = counterarguerRawInput?.sections?.length ?? 0;
  html += `
    <section id="counterarguer">
      <h2 class="section-toggle collapsed">Counterarguer (Bunky) (${counterarguerSectionCount} sections)</h2>
      <div class="section-content collapsed">
        <p class="section-blurb">Stage 7. After the tabloid is written, Bunky reads each section and drafts a short rebuttal blurb plus a longer critical analysis. Those blurbs are streamed back into the live article as the little yellow speech bubbles in the margin. This section shows Bunky's raw input and output.</p>
        <div class="ref-item">
          <div class="term-toggle collapsed">Input (${counterarguerInputTokens} tokens)</div>
          <div class="term-content collapsed">
`;
  if (counterarguerRawInput) {
    html += `            <pre class="grok-pre">${escapeHtml(JSON.stringify(counterarguerRawInput, null, 2))}</pre>\n`;
  } else {
    html += `            <p class="no-data">No raw input (re-run pipeline to capture).</p>\n`;
  }
  html += `          </div>
        </div>
        <div class="ref-item">
          <div class="term-toggle collapsed">Output (${counterarguerOutputTokens} tokens)</div>
          <div class="term-content collapsed">
`;
  if (counterarguerRawOutput) {
    html += `            <pre class="grok-pre">${escapeHtml(counterarguerRawOutput)}</pre>\n`;
  } else {
    html += `            <p class="no-data">No raw output (re-run pipeline to capture).</p>\n`;
  }
  html += `          </div>
        </div>
      </div>
    </section>
`;

  html += `
    <footer class="debug-footer">
      <p><a href="../../tabloid_generator/output/${escapeHtml(data.slug)}.html">← Back to the article</a> &middot; <a href="/">Home</a></p>
      <p>imright.com pipeline debug &middot; all data here was generated locally for the run above.</p>
    </footer>
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
    document.querySelectorAll('.term-toggle').forEach(function(toggle) {
      toggle.addEventListener('click', function() {
        const content = this.nextElementSibling;
        if (content) {
          content.classList.toggle('collapsed');
          this.classList.toggle('collapsed');
        }
      });
    });
    document.querySelectorAll('.ref-toggle').forEach(function(toggle) {
      toggle.addEventListener('click', function() {
        const content = this.nextElementSibling;
        if (content) {
          content.classList.toggle('collapsed');
          this.classList.toggle('collapsed');
        }
      });
    });
    document.querySelectorAll('tr.link-stat-toggle').forEach(function(toggle) {
      toggle.addEventListener('click', function() {
        const content = this.nextElementSibling;
        if (content && content.classList.contains('link-stat-details')) {
          content.classList.toggle('collapsed');
          this.classList.toggle('collapsed');
        }
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
  const linkStats = loadJson(`ref_extractor/link_stats/${slug}.json`);
  const conspiratorRawInput = loadJson(`conspirator/raw_input/${slug}.json`);
  const conspiratorRawOutput = loadRawText(`conspirator/raw_output/${slug}.txt`);
  const tabloidRawInput = loadJson(`tabloid_generator/raw_input/${slug}.json`);
  const tabloidRawOutput = loadRawText(`tabloid_generator/output_raw/${slug}.txt`);
  const counterarguerRawInput = loadJson(`counterarguer/input/${slug}.json`);
  const counterarguerRawOutput = loadRawText(`counterarguer/output/${slug}.txt`);

  const data = {
    slug,
    conspiracy,
    wikisFetched,
    wikisFiltered,
    extracted,
    runStats,
    linkStats,
    conspiratorRawInput,
    conspiratorRawOutput,
    tabloidRawInput,
    tabloidRawOutput,
    counterarguerRawInput,
    counterarguerRawOutput,
  };

  const html = buildHtml(data);

  const outputPath = path.join(PROJECT_ROOT, 'imright', 'debug', `${slug}.html`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  // Pipeline passes IMRIGHT_SILENT_DEBUG=1 and prints paths at end; standalone prints here
  if (!process.env.IMRIGHT_SILENT_DEBUG) {
    console.log(`Wrote ${outputPath}`);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
