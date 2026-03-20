/**
 * Search-then-extract: for each search query, search article content for factoids,
 * then find the first citation in the same paragraph and extract it.
 */

import { findAllRefs } from './parser/index.js';
import { parseAllCiteTemplates } from './parser/citeTemplate.js';
import { stripWikiMarkup, redactAllRefs } from './parser/index.js';

const REF_REGEX = /<ref[\s\S]*?<\/ref\s*>|<ref[^>]*\/\s*>/gi;

/**
 * Strip refs from text (replace with empty string) to get plain text for searching.
 */
function stripRefs(text) {
  return text.replace(REF_REGEX, '').trim();
}

/**
 * Split section content into paragraphs (by double newline).
 * Returns [{ text, start, end }] with positions relative to section start.
 */
function splitParagraphs(sectionContent, sectionStartInSource) {
  const paragraphs = [];
  const parts = sectionContent.split(/\n\n+/);
  let offset = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length < 20) {
      offset += part.length + 2;
      continue;
    }
    const start = offset;
    const end = offset + part.length;
    offset = end + 2;
    paragraphs.push({
      text: trimmed,
      start: sectionStartInSource + start,
      end: sectionStartInSource + end,
    });
  }
  return paragraphs;
}

/**
 * Build sections with source positions (same as parser).
 */
function buildSectionsWithRanges(source) {
  const sections = [];
  const headerRegex = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/gm;
  let lastEnd = 0;
  let prevName = 'Introduction';
  let match;

  while ((match = headerRegex.exec(source)) !== null) {
    const headerEnd = match.index + match[0].length;
    const content = source.slice(lastEnd, match.index);
    if (content.trim()) {
      sections.push({
        name: prevName,
        content,
        start: lastEnd,
        end: match.index,
      });
    }
    prevName = match[2].trim();
    lastEnd = headerEnd;
  }
  if (lastEnd < source.length) {
    sections.push({
      name: prevName,
      content: source.slice(lastEnd),
      start: lastEnd,
      end: source.length,
    });
  }
  return sections;
}

/**
 * Extract citations from a single article using search-then-extract.
 * For each matching paragraph, find first ref after match, validate, and extract.
 *
 * @param {string} source - Raw wiki markup
 * @param {string} articleTitle - Article title
 * @param {string[]} searchTerms - Terms to search for (query + argument)
 * @param {object} options - citationTypes, excludeUrlPatterns, minTermLength
 * @returns {Array<{ link, title, content, article_title, section }>}
 */
export function extractCitationsFromArticle(source, articleTitle, searchTerms, options = {}) {
  const citationTypes = options.citationTypes ?? new Set(['web', 'news', 'journal', 'magazine']);
  const excludeUrlPatterns = options.excludeUrlPatterns ?? [];
  const minTermLength = options.minTermLength ?? 5;

  const results = [];
  const refs = findAllRefs(source);
  const sections = buildSectionsWithRanges(source);

  const termsToSearch = new Set();
  for (const term of searchTerms) {
    if (!term || typeof term !== 'string') continue;
    const words = term.split(/\s+/).filter((word) => word.length >= minTermLength);
    words.forEach((word) => termsToSearch.add(word.toLowerCase()));
  }

  if (termsToSearch.size === 0) return results;

  for (const section of sections) {
    const paragraphs = splitParagraphs(section.content, section.start);
    for (const paragraph of paragraphs) {
      const paragraphSource = source.slice(paragraph.start, paragraph.end);
      const plainText = stripRefs(paragraphSource);
      const searchableText = stripWikiMarkup(plainText);
      if (searchableText.length < 30) continue;

      const matchesTerm = Array.from(termsToSearch).some((term) =>
        searchableText.toLowerCase().includes(term)
      );
      if (!matchesTerm) continue;

      const refsInParagraph = refs.filter(
        (ref) => ref.start >= paragraph.start && ref.end <= paragraph.end
      );
      if (refsInParagraph.length === 0) continue;

      const refsAfterMatch = refsInParagraph
        .sort((a, b) => a.start - b.start);
      const firstRef = refsAfterMatch[0];
      if (!firstRef) continue;

      const parsedList = parseAllCiteTemplates(firstRef.content);
      if (parsedList.length === 0) continue;

      for (const parsed of parsedList) {
        if (!citationTypes.has(parsed.type?.toLowerCase())) continue;
        if (!parsed.url || !parsed.url.startsWith('http')) continue;
        const linkLower = parsed.url.toLowerCase();
        if (excludeUrlPatterns.some((pattern) => linkLower.includes(pattern))) continue;

        const contentSlice = source.slice(paragraph.start, firstRef.start);
        const contentCleaned = stripWikiMarkup(redactAllRefs(contentSlice));

        results.push({
          link: parsed.url,
          title: (parsed.blurb ?? '').slice(0, 500),
          content: contentCleaned,
          article_title: articleTitle,
          section: section.name,
        });
      }
    }
  }

  return results;
}
