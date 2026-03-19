import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_CITATIONS_FOR_LLM = 80;

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = 'grok-4-1-fast-non-reasoning';

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system_prompt.txt'),
  'utf8'
).trim();

/** Strip [REF] placeholders and ''italic'' wiki markup for readability. */
function cleanSentence(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\[REF\]/g, '')
    .replace(/''/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Flatten extracted structure (Article -> Section -> citations) into a deduplicated list. */
function flattenAndDedupeCitations(extractedByArticle) {
  const seen = new Set();
  const citations = [];

  for (const articleTitle of Object.keys(extractedByArticle ?? {})) {
    const sections = extractedByArticle[articleTitle];
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

async function callGrok(topic, candidateArguments) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY is required. Set it in env or add to env.local in project root.');
  }

  const userMessage = `Topic/claim: ${topic}

Source material (use as evidence; each has text, blurb, link):
${JSON.stringify(candidateArguments, null, 2)}

Write an article. Embed links inline: [anchor text](url). Wrap the phrase each citation supports. Use these exact URLs. Return JSON with headline and paragraphs (each with "text" containing [anchor](url) links).`;

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

/** Escape HTML for safe output. */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Parse [anchor](url) markdown-style links and convert to HTML. Escapes non-link text. */
function processParagraphWithLinks(text) {
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    parts.push({ type: 'link', anchor: match[1], url: match[2] });
    lastIndex = match.index + match[0].length;
  }
  parts.push({ type: 'text', content: text.slice(lastIndex) });

  return parts
    .map((part) => {
      if (part.type === 'text') return escapeHtml(part.content);
      return `<a href="${escapeHtml(part.url)}" target="_blank" rel="noopener">${escapeHtml(part.anchor)}</a>`;
    })
    .join('');
}

/** Generate self-contained tabloid-style HTML. */
function generateHtml(selected, topic) {
  const headline = selected.headline ?? 'TRUTH FLASH!';
  const paragraphs = selected.paragraphs ?? [];

  const paragraphsHtml = paragraphs
    .map((paragraph) => {
      const rawText = paragraph.text ?? '';
      const processedHtml = processParagraphWithLinks(rawText);
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
    .article { margin: 2rem 0; }
    .article__paragraph {
      margin: 0 0 1.25rem 0;
      text-align: justify;
    }
    .article__paragraph:last-of-type { margin-bottom: 0; }
    .article__paragraph a {
      color: #6df4a1;
      text-decoration: none;
    }
    .article__paragraph a:hover { text-decoration: underline; }
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
  </div>
</body>
</html>`;
}

/**
 * Generates a tabloid-style HTML page from extracted citations.
 *
 * @param {string} claim - The topic/claim string
 * @param {object} extractedByArticle - Output from article_extractor ({ [articleTitle]: { [section]: [{ link, blurb, sentence }] } })
 * @returns {Promise<string>} - HTML string
 */
export async function generate(claim, extractedByArticle) {
  const allCitations = flattenAndDedupeCitations(extractedByArticle);
  const condensed = condenseForLlm(allCitations);

  const candidateArguments = condensed.map((citation) => ({
    text: citation.sentence || citation.blurb,
    blurb: citation.blurb,
    link: citation.link,
  }));

  const rawContent = await callGrok(claim, candidateArguments);

  let selected;
  try {
    selected = parseJsonResponse(rawContent);
  } catch (parseError) {
    throw new Error(`Failed to parse JSON from Grok response: ${parseError.message}`);
  }

  return generateHtml(selected, claim);
}
