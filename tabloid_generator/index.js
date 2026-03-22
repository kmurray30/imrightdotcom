import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callGrok } from '../utils/grok.js';

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

/** Generate self-contained tabloid-style HTML. */
function generateHtml(selected, topic, slug = null, citations = [], idToUrl = null) {
  const headline = selected.headline ?? 'TRUTH FLASH!';
  const sections = selected.sections ?? [];
  const urlToIndex = buildUrlToIndex(citations);
  const debugPageUrl = slug ? `../../imright/debug/${slug}.html` : null;

  // Support legacy format (paragraphs only) for backward compatibility
  const sectionsHtml =
    sections.length > 0
      ? sections
          .map((section) => {
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
    .masthead__debug {
      font-size: 0.8rem;
      margin-top: 1rem;
    }
    .masthead__debug a {
      color: #6df4a1;
      text-decoration: none;
    }
    .masthead__debug a:hover { text-decoration: underline; }
    .article { margin: 2rem 0; }
    .article__paragraph {
      margin: 0 0 1.25rem 0;
      text-align: justify;
    }
    .article__paragraph:last-of-type { margin-bottom: 0; }
    .article__section {
      margin-bottom: 2.5rem;
    }
    .article__section:last-child { margin-bottom: 0; }
    .article__heading {
      font-family: Impact, "Arial Black", sans-serif;
      font-size: 1.5rem;
      font-weight: 700;
      color: #fff;
      margin: 0 0 1rem 0;
      line-height: 1.3;
    }
    .article__paragraph a {
      color: #6df4a1;
      text-decoration: none;
    }
    .article__paragraph a:hover { text-decoration: underline; }
    .ref-num {
      font-size: 0.75em;
      color: #888;
      margin-left: 0.1em;
      text-decoration: none;
    }
    .ref-num:hover { color: #6df4a1; }
  </style>
</head>
<body>
  <div class="container">
    <header class="masthead">
      <p class="masthead__label">FACTS NEWS</p>
      <h1 class="headline">${escapeHtml(headline)}</h1>
      <p class="subtitle">${escapeHtml(topic)}</p>
      ${slug ? `<p class="masthead__debug"><a href="../../imright/debug/${escapeHtml(slug)}.html">Pipeline debug</a></p>` : ''}
    </header>
    <article class="article">
${sectionsHtml}
    </article>
  </div>
</body>
</html>`;
}

/**
 * Generates a tabloid-style HTML page from extracted citations.
 *
 * @param {string} claim - The topic/claim string
 * @param {object} extractedByTerm - Output from ref_extractor ({ [searchTerm]: [{ link, title, content }] })
 * @param {string} [slug] - Filename-safe slug for debug page link
 * @returns {Promise<string>} - HTML string
 */
export async function generate(claim, extractedByArticle, slug = null) {
  const allCitations = flattenAndDedupeCitations(extractedByArticle);
  const condensed = condenseForLlm(allCitations);

  // Use numeric IDs instead of URLs to save tokens; resolve to URLs when rendering HTML
  const idToUrl = new Map(condensed.map((citation, index) => [index + 1, citation.link]));
  const candidateArguments = condensed.map((citation, index) => ({
    id: index + 1,
    text: citation.content || citation.title,
    title: citation.title,
  }));

  const userMessage = `User's main claim (build the whole article around this): ${claim}

Source material (use as evidence; each has id, text, title):
${JSON.stringify(candidateArguments, null, 2)}

Write using the two-step process. Headline and every section heading must advance the case for the user's main claim above. First list claims in chain_of_thought.claims, then write the article in article (headline + sections). Embed links INLINE as [phrase](id) where id is the source's numeric id (1, 2, 3…). Never use full URLs—use only the id number. Return JSON with chain_of_thought and article.`;
  const rawContent = await callGrok([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ]);

  // Write raw LLM output to output_raw/ for inspection before HTML generation
  if (slug) {
    const outputRawDir = path.join(__dirname, 'output_raw');
    fs.mkdirSync(outputRawDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputRawDir, `${slug}.txt`),
      rawContent,
      'utf8'
    );
  }

  let parsed;
  try {
    parsed = parseJsonResponse(rawContent);
  } catch (parseError) {
    throw new Error(`Failed to parse JSON from Grok response: ${parseError.message}`);
  }

  // Extract article from chain-of-thought structure; discard reasoning
  const selected = parsed.article ?? parsed;

  return generateHtml(selected, claim, slug, condensed, idToUrl);
}
