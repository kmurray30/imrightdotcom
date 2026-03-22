import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { callGrok } from '../utils/grok.js';
import { fetchImage, downloadImage } from '../utils/pixabay.js';

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

/** Generate self-contained tabloid-style HTML. */
function generateHtml(selected, topic, slug = null, citations = [], idToUrl = null, imagePaths = null) {
  const headline = selected.headline ?? 'TRUTH FLASH!';
  const intro = selected.intro;
  const conclusion = selected.conclusion;
  const sections = selected.sections ?? [];
  const urlToIndex = buildUrlToIndex(citations);
  const debugPageUrl = slug ? `../../imright/debug/${slug}.html` : null;
  const imageMap = imagePaths instanceof Map ? imagePaths : new Map();

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

  // Support legacy format (paragraphs only) for backward compatibility
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
            return `    <section class="article__section">
    <h2 class="article__heading">${escapeHtml(heading)}</h2>
${paragraphsHtml}
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
    }
    .site-header__logo {
      font-size: 1.25rem;
      font-weight: 700;
      color: #ee3322;
      letter-spacing: -0.02em;
      text-decoration: none;
    }
    .site-header__logo:hover { color: #c4291c; }
    .container {
      max-width: 680px;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }
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
    .site-header__debug {
      font-size: 0.8rem;
    }
    .site-header__debug a {
      color: #6e6e73;
      text-decoration: none;
    }
    .site-header__debug a:hover { color: #0f65ef; text-decoration: underline; }
    .article {
      background: #fff;
      border-radius: 12px;
      padding: 2rem 1.75rem;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      margin-bottom: 2rem;
    }
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
      margin-bottom: 2rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid #e5e5e7;
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
  </style>
</head>
<body>
  <header class="site-header">
    <div class="site-header__inner">
      <a href="#" class="site-header__logo">TruthFeed</a>
      ${slug ? `<span class="site-header__debug"><a href="../../imright/debug/${escapeHtml(slug)}.html" target="_blank" rel="noopener">Debug</a></span>` : ''}
    </div>
  </header>
  <div class="container">
    <div class="article-hero">
      <p class="article-hero__topic">${escapeHtml(topic)}</p>
      <h1 class="headline">${escapeHtml(headline)}</h1>
    </div>
    <article class="article">
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
  return generateHtml(article, topic, slug, condensed, idToUrl, imagePaths);
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

  return generateHtml(selected, topic, slug, condensed, idToUrl, imagePaths);
}
