import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { callGrok } from '../utils/grok.js';
import { downloadImage, fetchImage } from '../utils/pixabay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_CITATIONS_FOR_LLM = 80;
/** Number of refs to show in visualizer and to number in article; must match imright/scripts/generate-debug.js TOP_K_REFS */
const REF_NUMBERS_COUNT = 50;

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system_prompt.txt'),
  'utf8'
).trim();

/** Strip [REF] placeholders and ''italic'' wiki markup for readability. */
function cleanContent(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\[REF\]/g, '')
    .replace(/''/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Flatten extracted structure (search term -> citations) into a deduplicated list. */
function flattenAndDedupeCitations(extractedByTerm) {
  const seen = new Set();
  const citations = [];

  for (const searchTerm of Object.keys(extractedByTerm ?? {})) {
    const items = extractedByTerm[searchTerm];
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const link = item?.link;
      const title = item?.title ?? '';
      const content = cleanContent(item?.content ?? '');
      if (!link || !link.startsWith('http')) continue;

      const key = link + '|' + title;
      if (seen.has(key)) continue;
      seen.add(key);

      citations.push({ link, title, content, searchTerm });
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

/** Escape HTML for safe output. */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse [anchor](url) or [anchor](id) markdown-style links and convert to HTML.
 * IDs are resolved to URLs via idToUrl. If urlToIndex is provided, appends [N] ref numbers next to each link (matching visualizer).
 * @param {string} text - Paragraph text with [phrase](url) or [phrase](id) markdown
 * @param {Map<number, string>} [idToUrl] - Map from numeric id (1, 2, 3…) to URL
 * @param {Map<string, number>} [urlToIndex] - Map from URL to 1-based ref number
 * @param {string} [debugPageUrl] - Base URL for debug page (for ref number links)
 */
function processParagraphWithLinks(text, idToUrl = null, urlToIndex = null, debugPageUrl = null) {
  // Match [text](target) where target is a numeric id or a full URL (legacy)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    parts.push({ type: 'link', anchor: match[1], target: match[2] });
    lastIndex = match.index + match[0].length;
  }
  parts.push({ type: 'text', content: text.slice(lastIndex) });

  return parts
    .map((part) => {
      if (part.type === 'text') return escapeHtml(part.content);
      // Resolve numeric id to URL, or use target as URL if it looks like one (legacy)
      const numericId = /^\d+$/.test(part.target) ? parseInt(part.target, 10) : null;
      const resolvedUrl = idToUrl?.has(numericId) ? idToUrl.get(numericId) : part.target;
      // If numeric id but not in map, render as plain text (invalid ref)
      const isValidLink = resolvedUrl && (resolvedUrl.startsWith('http') || resolvedUrl.startsWith('//'));
      const linkHtml = isValidLink
        ? `<a href="${escapeHtml(resolvedUrl)}" target="_blank" rel="noopener">${escapeHtml(part.anchor)}</a>`
        : escapeHtml(part.anchor);
      const refNum = urlToIndex?.get(resolvedUrl);
      if (refNum != null && debugPageUrl) {
        return `${linkHtml}<a href="${escapeHtml(debugPageUrl)}#ref-${refNum}" class="ref-num" title="See reference ${refNum}">[${refNum}]</a>`;
      }
      return linkHtml;
    })
    .join('');
}

/**
 * Build urlToIndex map from ordered citations: first occurrence of each URL gets its 1-based index.
 * Used to add [1] [2] ref numbers next to links in the article.
 */
function buildUrlToIndex(citations) {
  const urlToIndex = new Map();
  const capped = citations.slice(0, REF_NUMBERS_COUNT);
  for (let index = 0; index < capped.length; index++) {
    const url = capped[index]?.link;
    if (url && !urlToIndex.has(url)) {
      urlToIndex.set(url, index + 1);
    }
  }
  return urlToIndex;
}

/**
 * Fetch images from Pixabay for article photo_queries and download to local images dir.
 * Runs fetches concurrently. Returns Map of key -> filename for successfully downloaded images.
 *
 * @param {object} article - Parsed article with photo_query (top-level) and sections[].photo_query
 * @param {string} slug - Filename-safe slug
 * @param {string} projectRoot - Absolute path to project root
 * @returns {Promise<Map<string, string>>} - Map of 'hero'|'section-0'|... -> filename (e.g. 'hero.jpg')
 */
export async function fetchAndDownloadImages(article, slug, projectRoot) {
  const imagePaths = new Map();
  const imagesDir = path.join(projectRoot, 'tabloid_generator', 'images', slug);

  const queries = [];

  const heroQuery = article?.photo_query;
  if (heroQuery && typeof heroQuery === 'string' && heroQuery.trim()) {
    queries.push({ key: 'hero', query: heroQuery.trim() });
  }

  const sections = article?.sections ?? [];
  sections.forEach((section, index) => {
    const sectionQuery = section?.photo_query;
    if (sectionQuery && typeof sectionQuery === 'string' && sectionQuery.trim()) {
      queries.push({ key: `section-${index}`, query: sectionQuery.trim() });
    }
  });

  if (queries.length === 0) return imagePaths;

  // Fetch all image URLs concurrently
  const fetchResults = await Promise.all(
    queries.map(async ({ key, query }) => {
      try {
        const url = await fetchImage(query);
        return { key, url };
      } catch (err) {
        console.error(`Pixabay fetch failed for "${query}":`, err.message);
        return { key, url: null };
      }
    })
  );

  // Download all successfully fetched images concurrently
  const downloadPromises = fetchResults
    .filter((r) => r.url)
    .map(async ({ key, url }) => {
      const ext = url?.match(/\.(jpg|jpeg|png|webp)/i)?.[1] ?? 'jpg';
      const filename = `${key}.${ext}`;
      const destPath = path.join(imagesDir, filename);
      try {
        await downloadImage(url, destPath);
        return { key, filename };
      } catch (err) {
        console.error(`Download failed for ${key}:`, err.message);
        return null;
      }
    });

  const downloadResults = await Promise.all(downloadPromises);
  for (const result of downloadResults) {
    if (result) imagePaths.set(result.key, result.filename);
  }

  return imagePaths;
}

/** Get Bunky image as data URL for self-contained HTML (avoids file:// path issues). */
function getBunkyDataUrl(projectRoot) {
  const root = projectRoot || path.resolve(__dirname, '..');
  const bunkyPath = fs.existsSync(path.join(root, 'assets', 'bunky.png'))
    ? path.join(root, 'assets', 'bunky.png')
    : path.join(root, 'bunky.png');
  if (fs.existsSync(bunkyPath)) {
    const buf = fs.readFileSync(bunkyPath);
    return 'data:image/png;base64,' + buf.toString('base64');
  }
  return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><ellipse cx="24" cy="32" rx="14" ry="8" fill="%23654321"/><ellipse cx="24" cy="26" rx="12" ry="10" fill="%238B6914"/><ellipse cx="20" cy="22" rx="3" ry="2" fill="%23333"/><ellipse cx="28" cy="22" rx="3" ry="2" fill="%23333"/></svg>');
}

/** Generate self-contained tabloid-style HTML. */
function generateHtml(selected, topic, slug = null, citations = [], idToUrl = null, imagePaths = null, bunkyDataUrl = null) {
  const headline = selected.headline ?? 'TRUTH FLASH!';
  const intro = selected.intro;
  const conclusion = selected.conclusion;
  const sections = selected.sections ?? [];
  const urlToIndex = buildUrlToIndex(citations);
  const debugPageUrl = slug ? `../../imright/debug/${slug}.html` : null;
  const imageMap = imagePaths instanceof Map ? imagePaths : new Map();
  const publishedDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Intro is written after sections by Grok but rendered first in the article, in its own section
  const introHtml = intro
    ? (() => {
        const introParagraphs = Array.isArray(intro) ? intro : [intro];
        const paragraphsHtml = introParagraphs
          .map((paragraph) => {
            const rawText = typeof paragraph === 'string' ? paragraph : (paragraph?.text ?? '');
            const processedHtml = processParagraphWithLinks(rawText, idToUrl, urlToIndex, debugPageUrl);
            return `      <p class="article__intro">${processedHtml}</p>`;
          })
          .join('\n');
        return `    <section class="article__intro-section">
${paragraphsHtml}
    </section>`;
      })()
    : '';

  const hasBunky = slug && sections.length > 0;
  const resolvedBunkyUrl = bunkyDataUrl || getBunkyDataUrl();

  // Sections — when Bunky is active, embed a callout inside each section.
  // The callout is position:absolute so it floats outside the article card to the right,
  // perfectly aligned with its section, no JS positioning needed.
  const sectionsHtml =
    sections.length > 0
      ? sections
          .map((section, sectionIndex) => {
            const heading = section.heading ?? '';
            const paragraphs = section.paragraphs ?? [];
            const paragraphsHtml = paragraphs
              .map((paragraph) => {
                const rawText = typeof paragraph === 'string' ? paragraph : (paragraph?.text ?? '');
                const processedHtml = processParagraphWithLinks(rawText, idToUrl, urlToIndex, debugPageUrl);
                return `      <p class="article__paragraph">${processedHtml}</p>`;
              })
              .join('\n');
            const bunkyCalloutHtml = hasBunky
              ? `\n      <div class="bunky-callout" data-section-index="${sectionIndex}">
        <img class="bunky-callout__img" src="${resolvedBunkyUrl}" alt="Bunky" title="Bunky the BS Detector">
        <div class="article__bunky-bubble article__bunky-bubble--thinking" data-section-index="${sectionIndex}" role="button" tabindex="0">...</div>
      </div>`
              : '';
            return `    <section class="article__section" data-section-index="${sectionIndex}">
    <h2 class="article__heading">${escapeHtml(heading)}</h2>
${paragraphsHtml}${bunkyCalloutHtml}
    </section>`;
          })
          .join('\n')
      : (selected.paragraphs ?? [])
          .map((paragraph) => {
            const rawText = typeof paragraph === 'string' ? paragraph : (paragraph?.text ?? '');
            const processedHtml = processParagraphWithLinks(rawText, idToUrl, urlToIndex, debugPageUrl);
            return `    <p class="article__paragraph">${processedHtml}</p>`;
          })
          .join('\n');

  // Conclusion appears at the end of the article
  const conclusionHtml = conclusion
    ? (() => {
        const conclusionParagraphs = Array.isArray(conclusion) ? conclusion : [conclusion];
        return conclusionParagraphs
          .map((paragraph) => {
            const rawText = typeof paragraph === 'string' ? paragraph : (paragraph?.text ?? '');
            const processedHtml = processParagraphWithLinks(rawText, idToUrl, urlToIndex, debugPageUrl);
            return `    <p class="article__conclusion">${processedHtml}</p>`;
          })
          .join('\n');
      })()
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(headline)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f7;
      color: #1d1d1f;
      line-height: 1.6;
      font-size: 17px;
    }
    .site-header {
      background: #fff;
      border-bottom: 1px solid #e5e5e7;
      padding: 1rem 0;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .site-header__inner {
      max-width: 680px;
      margin: 0 auto;
      padding: 0 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: relative;
    }
    .site-header__back {
      position: absolute;
      left: 1.25rem;
      top: 50%;
      transform: translateY(-50%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      color: #a1a1a6;
      text-decoration: none;
      font-size: 1.1rem;
      line-height: 1;
      transition: color 0.15s ease, background 0.15s ease;
    }
    .site-header__back:hover {
      color: #1d1d1f;
      background: rgba(0, 0, 0, 0.04);
    }
    .site-header__logo {
      font-size: 1.25rem;
      font-weight: 700;
      color: #ee3322;
      letter-spacing: -0.02em;
      text-decoration: none;
      margin: 0 auto;
    }
    .site-header__logo:hover { color: #c4291c; }
    .container { max-width: 680px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    .container--with-bunky { max-width: 900px; }
    .article-hero {
      margin-bottom: 2rem;
    }
    .article-hero__topic {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #0f65ef;
      margin-bottom: 0.5rem;
    }
    .headline {
      font-size: 2.25rem;
      font-weight: 700;
      line-height: 1.2;
      color: #1d1d1f;
      margin: 0 0 0.75rem 0;
      letter-spacing: -0.02em;
    }
    .site-footer {
      max-width: 680px;
      margin: 2rem auto 0 auto;
      padding: 1.5rem 1.25rem 2.5rem 1.25rem;
      border-top: 1px solid #e5e5e7;
      color: #8e8e93;
      font-size: 0.8rem;
      text-align: center;
    }
    .site-footer p { margin: 0 0 0.35rem 0; }
    .site-footer p:last-child { margin-bottom: 0; }
    .site-footer__how-link {
      color: #6e6e73;
      text-decoration: none;
      border-bottom: 1px dotted #c1c1c6;
    }
    .site-footer__how-link:hover {
      color: #0f65ef;
      border-bottom-color: #0f65ef;
    }
    .article {
      background: #fff;
      border-radius: 12px;
      padding: 2rem 1.75rem;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      margin-bottom: 2rem;
      overflow: visible;
    }
    .article--has-bunky { margin-right: 180px; }
    .article__intro-section {
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid #e5e5e7;
    }
    .article__intro {
      font-size: 1.15rem;
      margin: 0 0 1.5rem 0;
      color: #1d1d1f;
      line-height: 1.65;
    }
    .article__intro:last-of-type { margin-bottom: 0; }
    .article__section {
      position: relative;
      margin-bottom: 2rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid #e5e5e7;
    }
    .bunky-callout {
      position: absolute;
      right: 0;
      top: 0;
      transform: translateX(calc(100% + 1.25rem));
      width: 140px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
    }
    .bunky-callout__img {
      width: 48px;
      height: 48px;
      object-fit: contain;
    }
    .article__section:last-of-type { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
    .article__heading {
      font-size: 1.35rem;
      font-weight: 700;
      color: #1d1d1f;
      margin: 0 0 1rem 0;
      line-height: 1.35;
      letter-spacing: -0.01em;
    }
    .article__paragraph {
      margin: 0 0 1.25rem 0;
      color: #424245;
      line-height: 1.65;
    }
    .article__paragraph:last-of-type { margin-bottom: 0; }
    .article__conclusion {
      font-size: 1.15rem;
      margin: 2rem 0 0 0;
      padding-top: 1.5rem;
      border-top: 1px solid #e5e5e7;
      color: #1d1d1f;
      line-height: 1.65;
    }
    .article__conclusion:last-of-type { margin-bottom: 0; }
    .article__paragraph a,
    .article__intro a,
    .article__conclusion a {
      color: #0f65ef;
      text-decoration: none;
      font-weight: 500;
    }
    .article__paragraph a:hover,
    .article__intro a:hover,
    .article__conclusion a:hover {
      text-decoration: underline;
      color: #0047ab;
    }
    .ref-num {
      font-size: 0.7em;
      color: #8e8e93;
      margin-left: 0.15em;
      text-decoration: none;
    }
    .ref-num:hover { color: #0f65ef; }
    .article__hero-image {
      margin: 0 0 1.5rem 0;
    }
    .article__hero-image img,
    .article__section-image img {
      width: 100%;
      max-height: 360px;
      object-fit: cover;
      border-radius: 8px;
    }
    .article__section-image {
      margin: 0 0 1rem 0;
    }
    .article__bunky-bubble {
      max-width: 140px;
      padding: 0.5rem 0.75rem;
      background: #fff9e6;
      border: 2px solid #e6d9a8;
      border-radius: 12px;
      font-size: 0.85rem;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
      text-align: center;
    }
    .article__bunky-bubble:hover {
      background: #fff3cc;
      border-color: #d4c76a;
    }
    .article__bunky-bubble[data-has-analysis="true"] { cursor: pointer; }
    .article__bunky-bubble--thinking {
      animation: bunky-thinking 1.5s ease-in-out infinite;
    }
    @keyframes bunky-thinking {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.7; transform: scale(1.05); }
    }
    .bunky-panel {
      position: fixed;
      top: 0;
      right: 0;
      /* Err small on wide/medium viewports (a 380px panel is ~27% of a
       * 1400px screen and ~42% of a 900px screen), then smoothly grow as
       * a percentage as the viewport keeps shrinking. Caps at 65vw so the
       * panel never takes over more than about two-thirds of the screen. */
      width: min(380px, 65vw);
      height: 100vh;
      background: #fff;
      box-shadow: -4px 0 24px rgba(0,0,0,0.12);
      z-index: 1000;
      transform: translateX(100%);
      transition: transform 0.25s ease-out;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .bunky-panel.is-open { transform: translateX(0); }
    .bunky-panel__header {
      flex-shrink: 0;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid #e5e5e7;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .bunky-panel__title { font-size: 0.95rem; font-weight: 600; margin: 0; color: #1d1d1f; }
    .bunky-panel__close {
      background: none;
      border: none;
      font-size: 1.5rem;
      line-height: 1;
      cursor: pointer;
      color: #8e8e93;
      padding: 0.25rem;
    }
    .bunky-panel__close:hover { color: #1d1d1f; }
    .bunky-panel__analysis {
      flex: 1;
      overflow-y: auto;
      padding: 1rem 1.25rem;
      font-size: 0.9rem;
      line-height: 1.65;
      color: #424245;
      white-space: pre-wrap;
    }

    /* When the viewport is narrower than the side-gutter layout can support
     * (900px container + 180px right gutter for Bunky bubbles), the 180px
     * right margin on .article--has-bunky reserves space that doesn't exist
     * and squishes the article text. Drop the gutter and render each Bunky
     * callout inline at the end of its section. The image and speech bubble
     * sit on a single row (image on the left, bubble flexing to fill the
     * remaining width) so the bubble doesn't wrap below Bunky. */
    @media (max-width: 860px) {
      .container--with-bunky { max-width: 680px; }
      .article--has-bunky { margin-right: 0; }
      .bunky-callout {
        position: static;
        transform: none;
        width: auto;
        margin-top: 1rem;
        flex-direction: row;
        align-items: center;
        gap: 0.75rem;
      }
      .bunky-callout__img { flex-shrink: 0; }
      .article__bunky-bubble {
        max-width: none;
        flex: 1;
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="site-header__inner">
      <a href="/" class="site-header__back" aria-label="Back to imright.com" title="Back">&larr;</a>
      <a href="/" class="site-header__logo">imright.com</a>
    </div>
  </header>
  <div class="container${hasBunky ? ' container--with-bunky' : ''}">
    <div class="article-hero">
      <p class="article-hero__topic">${escapeHtml(topic)}</p>
      <h1 class="headline">${escapeHtml(headline)}</h1>
    </div>
    <article class="article${hasBunky ? ' article--has-bunky' : ''}">
${(() => {
  const heroFilename = imageMap.get('hero');
  return heroFilename && slug
    ? `    <figure class="article__hero-image"><img src="../images/${slug}/${heroFilename}" alt="" loading="lazy"></figure>\n`
    : '';
})()}${introHtml}
${sectionsHtml}
${conclusionHtml}
    </article>
  </div>
  <div class="bunky-panel" id="bunkyPanel" aria-hidden="true">
    <div class="bunky-panel__header">
      <p class="bunky-panel__title">Bunky says:</p>
      <button class="bunky-panel__close" type="button" aria-label="Close">&times;</button>
    </div>
    <div class="bunky-panel__analysis" id="bunkyPanelAnalysis"></div>
  </div>
  <!-- BUNKY_COUNTERARGS_PLACEHOLDER -->
  <script>
(function() {
  var slug = ${slug ? JSON.stringify(slug) : 'null'};
  if (!slug) return;
  function applyCounterargs(data) {
    if (!data || !Array.isArray(data.counterarguments)) return;
    var list = data.counterarguments;
    document.querySelectorAll(".article__bunky-bubble").forEach(function(bubble) {
      var idx = parseInt(bubble.getAttribute("data-section-index"), 10);
      if (idx < 0 || idx >= list.length) return;
      var item = list[idx];
      if (!item || !item.blurb) return;
      bubble.textContent = item.blurb;
      bubble.classList.remove("article__bunky-bubble--thinking");
      bubble.setAttribute("data-has-analysis", item.analysis ? "true" : "false");
      bubble._analysis = item.analysis || "";
    });
  }
  function tryApply(data) {
    if (data && Array.isArray(data.counterarguments) && data.counterarguments.length > 0) {
      applyCounterargs(data);
      return true;
    }
    return false;
  }
  if (window.__BUNKY_COUNTERARGS && tryApply(window.__BUNKY_COUNTERARGS)) {
    // Embedded at build time, done
  } else {
    var counterargsUrl = "../counterarguments/" + slug + ".json";
    var pollAttempts = 0;
    var maxPollAttempts = 150; // ~5 min at 2s
    function poll() {
      pollAttempts++;
      fetch(counterargsUrl).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
        if (tryApply(data)) return;
        if (pollAttempts < maxPollAttempts) setTimeout(poll, 2000);
      }).catch(function() {
        if (pollAttempts < maxPollAttempts) setTimeout(poll, 2000);
      });
    }
    poll();
  }

  var panel = document.getElementById("bunkyPanel");
  var analysisEl = document.getElementById("bunkyPanelAnalysis");
  var closeBtn = panel && panel.querySelector(".bunky-panel__close");
  // The bubble whose analysis is currently displayed. Used to toggle the
  // panel closed when the same bubble is clicked twice, and to open with
  // fresh content when a different bubble is clicked while the panel is
  // already open.
  var activeBubble = null;
  function closeBunkyPanel() {
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    activeBubble = null;
  }
  document.addEventListener("click", function(e) {
    var bubble = e.target.closest('.article__bunky-bubble[data-has-analysis="true"]');
    if (!bubble || !bubble._analysis) return;
    if (panel.classList.contains("is-open") && activeBubble === bubble) {
      closeBunkyPanel();
      return;
    }
    analysisEl.textContent = bubble._analysis;
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
    activeBubble = bubble;
  });
  if (closeBtn) closeBtn.addEventListener("click", closeBunkyPanel);
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && panel && panel.classList.contains("is-open")) {
      closeBunkyPanel();
    }
  });

})();
  </script>
  <footer class="site-footer">
    <p>${slug ? `<a class="site-footer__how-link" href="../../imright/debug/${escapeHtml(slug)}.html" target="_blank" rel="noopener">Find out how this works</a>` : ''}</p>
    <p>imright.com &middot; Published ${publishedDate}</p>
  </footer>
</body>
</html>`;
}

/**
 * Generates the article content via Grok (stage 5). Does not fetch images or render HTML.
 *
 * @param {string} claim - The topic/claim string
 * @param {object} extractedByTerm - Output from ref_extractor ({ [searchTerm]: [{ link, title, content }] })
 * @param {string} [slug] - Filename-safe slug for debug page link
 * @returns {Promise<{ article, condensed, idToUrl, topic }>} - Data needed for HTML generation
 */
export async function generateArticle(claim, extractedByArticle, slug = null) {
  const allCitations = flattenAndDedupeCitations(extractedByArticle);
  const condensed = condenseForLlm(allCitations);

  const idToUrl = new Map(condensed.map((citation, index) => [index + 1, citation.link]));
  const candidateArguments = condensed.map((citation, index) => ({
    id: index + 1,
    text: citation.content || citation.title,
    title: citation.title,
  }));

  const userMessage = `User's main claim (build the whole article around this): ${claim}

Source material (use as evidence; each has id, text, title):
${JSON.stringify(candidateArguments, null, 2)}`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];
  if (slug) {
    const rawInputDir = path.join(__dirname, 'raw_input');
    fs.mkdirSync(rawInputDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawInputDir, `${slug}.json`),
      JSON.stringify({ messages }, null, 2),
      'utf8'
    );
  }
  const rawContent = await callGrok(messages);

  if (slug) {
    const outputRawDir = path.join(__dirname, 'output_raw');
    fs.mkdirSync(outputRawDir, { recursive: true });
    fs.writeFileSync(path.join(outputRawDir, `${slug}.txt`), rawContent, 'utf8');
  }

  let parsed;
  try {
    parsed = parseJsonResponse(rawContent);
  } catch (parseError) {
    throw new Error(`Failed to parse JSON from Grok response: ${parseError.message}`);
  }

  const article = parsed.article ?? parsed;
  return { article, condensed, idToUrl, topic: claim };
}

/**
 * Fetches images and renders HTML (stage 6).
 *
 * @param {object} articleResult - From generateArticle: { article, condensed, idToUrl, topic }
 * @param {string} slug - Filename-safe slug
 * @param {string} projectRoot - Absolute path to project root
 * @returns {Promise<string>} - HTML string
 */
export async function renderWithImages(articleResult, slug, projectRoot) {
  const { article, condensed, idToUrl, topic } = articleResult;
  const imagePaths = await fetchAndDownloadImages(article, slug, projectRoot);
  const bunkyDataUrl = (slug && (article?.sections ?? []).length > 0) ? getBunkyDataUrl(projectRoot) : null;
  return generateHtml(article, topic, slug, condensed, idToUrl, imagePaths, bunkyDataUrl);
}

/**
 * Full generate: article + images + HTML. Convenience wrapper for single-call usage.
 *
 * @param {string} claim - The topic/claim string
 * @param {object} extractedByTerm - Output from ref_extractor
 * @param {string} [slug] - Filename-safe slug
 * @param {string} [projectRoot] - Project root (required for image fetching)
 * @returns {Promise<string>} - HTML string
 */
export async function generate(claim, extractedByArticle, slug = null, projectRoot = null) {
  const articleResult = await generateArticle(claim, extractedByArticle, slug);
  const root = projectRoot ?? path.resolve(__dirname, '..');
  return renderWithImages(articleResult, slug, root);
}

/**
 * Regenerate HTML from existing output_raw and extracted data (no Grok call).
 * Use when pipeline data exists and you only need to refresh the rendered output.
 *
 * @param {string} slug - Filename-safe slug (e.g. vaccines-cause-autism)
 * @param {string} projectRoot - Absolute path to project root
 * @returns {string} - HTML string
 * @throws {Error} - If output_raw or extracted files are missing
 */
export async function regenerateFromRaw(slug, projectRoot) {
  const outputRawPath = path.join(__dirname, 'output_raw', `${slug}.txt`);
  const extractedPath = path.join(projectRoot, 'ref_extractor', 'extracted', `${slug}.yaml`);

  if (!fs.existsSync(outputRawPath)) {
    throw new Error(`Missing output_raw: ${outputRawPath}. Run the full pipeline first.`);
  }
  if (!fs.existsSync(extractedPath)) {
    throw new Error(`Missing extracted: ${extractedPath}. Run the full pipeline first.`);
  }

  const rawContent = fs.readFileSync(outputRawPath, 'utf8');
  const extracted = (() => {
    try {
      return yaml.parse(fs.readFileSync(extractedPath, 'utf8'));
    } catch (parseError) {
      throw new Error(`Failed to parse extracted YAML: ${parseError.message}`);
    }
  })();

  const allCitations = flattenAndDedupeCitations(extracted);
  const condensed = condenseForLlm(allCitations);
  const idToUrl = new Map(condensed.map((citation, index) => [index + 1, citation.link]));

  let parsed;
  try {
    parsed = parseJsonResponse(rawContent);
  } catch (parseError) {
    throw new Error(`Failed to parse JSON from output_raw: ${parseError.message}`);
  }

  const selected = parsed.article ?? parsed;
  if (!selected) throw new Error('No article in output_raw JSON.');

  // Topic from conspiracy or wiki_filtered, fallback to slug-with-spaces
  let topic = slug.replace(/-/g, ' ');
  const conspiracyPath = path.join(projectRoot, 'conspirator', 'conspiracies', `${slug}.yaml`);
  const wikiFilteredPath = path.join(projectRoot, 'wiki_filterer', 'wikis-filtered', `${slug}.yaml`);
  if (fs.existsSync(conspiracyPath)) {
    try {
      const conspiracy = yaml.parse(fs.readFileSync(conspiracyPath, 'utf8'));
      if (conspiracy?.topic) topic = conspiracy.topic;
    } catch {
      // Ignore
    }
  } else if (fs.existsSync(wikiFilteredPath)) {
    try {
      const wiki = yaml.parse(fs.readFileSync(wikiFilteredPath, 'utf8'));
      if (wiki?.query) topic = wiki.query;
    } catch {
      // Ignore
    }
  }

  const imagePaths =
    selected?.photo_query || (selected?.sections ?? []).some((s) => s?.photo_query)
      ? await fetchAndDownloadImages(selected, slug, projectRoot)
      : new Map();

  const bunkyDataUrl = (selected?.sections ?? []).length > 0 ? getBunkyDataUrl(projectRoot) : null;
  return generateHtml(selected, topic, slug, condensed, idToUrl, imagePaths, bunkyDataUrl);
}
