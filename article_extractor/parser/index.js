/**
 * Parses Wikipedia source to extract citations with surrounding context.
 */

import { parseCiteTemplate } from './citeTemplate.js';

const REF_OPEN = /<ref(?:\s+name\s*=\s*["']?([^"'>\s]+)["']?)?\s*>/gi;
const REF_CLOSE = /<\/ref\s*>/gi;
const REF_SELF_CLOSING = /<ref(?:\s+name\s*=\s*["']?([^"'>\s]+)["']?)?\s*\/\s*>/gi;

const SENTENCE_END = /[.!?]+[\s\n]+/g;

/**
 * Find all ref tags and their positions. Returns array of { name, content, start, end }.
 * First pass: collect definitions. Second pass: expand named refs.
 */
function findAllRefs(source) {
  const namedRefs = new Map();
  const refs = [];

  const findRefsWithRegex = (regex, isClosing = false) => {
    let match;
    const re = new RegExp(regex.source, 'gi');
    while ((match = re.exec(source)) !== null) {
      if (isClosing) {
        refs.push({ type: 'close', index: match.index, length: match[0].length });
      } else {
        const name = match[1] || null;
        const fullMatch = match[0];
        const isSelfClosing = /\/\s*>/.test(fullMatch);
        if (isSelfClosing) {
          refs.push({
            type: 'ref',
            name,
            content: null,
            start: match.index,
            end: match.index + fullMatch.length,
            selfClosing: true,
          });
        } else {
          refs.push({
            type: 'ref',
            name,
            content: null,
            start: match.index,
            end: -1,
            selfClosing: false,
          });
        }
      }
    }
  };

  findRefsWithRegex(REF_OPEN);
  findRefsWithRegex(REF_SELF_CLOSING);
  findRefsWithRegex(REF_CLOSE, true);

  const closes = refs.filter((r) => r.type === 'close');
  const opens = refs.filter((r) => r.type === 'ref').sort((a, b) => a.start - b.start);

  let closeIndex = 0;
  for (const open of opens) {
    if (open.selfClosing) continue;
    while (closeIndex < closes.length && closes[closeIndex].index < open.start) {
      closeIndex++;
    }
    if (closeIndex < closes.length) {
      open.end = closes[closeIndex].index + closes[closeIndex].length;
      open.content = source.slice(open.start, open.end).replace(/<ref[^>]*>|<\/ref\s*>/gi, '').trim();
      if (open.name && !namedRefs.has(open.name)) {
        namedRefs.set(open.name, open.content);
      }
      closeIndex++;
    }
  }

  for (const open of opens) {
    if (open.selfClosing && open.name && namedRefs.has(open.name)) {
      open.content = namedRefs.get(open.name);
      open.selfClosing = false;
      open.end = open.start;
      const len = source.slice(open.start).match(/<ref[^>]*\/\s*>/i)?.[0]?.length ?? 0;
      open.end = open.start + len;
    }
  }

  return opens.filter((r) => r.content !== null);
}

/**
 * Extract the sentence(s) containing the ref. priorSentences = how many sentences before the ref to include.
 * Returns { text, startIndex } so caller can compute ref position in the returned text.
 */
function extractSurroundingSentence(source, refStart, refEnd, priorSentences = 1) {
  const beforeRef = source.slice(0, refStart);
  const afterRef = source.slice(refEnd);

  const sentenceStarts = [];
  let match;
  const beforeRegex = new RegExp(SENTENCE_END.source, 'g');
  while ((match = beforeRegex.exec(beforeRef)) !== null) {
    sentenceStarts.push(match.index + match[0].length);
  }

  const startIndex =
    sentenceStarts.length >= priorSentences
      ? sentenceStarts[sentenceStarts.length - priorSentences]
      : 0;

  const endMatch = afterRef.match(/^[^.!?]*[.!?]/);
  const endOffset = endMatch ? endMatch[0].length : Math.min(50, afterRef.length);
  const endIndex = refEnd + endOffset;

  return { text: source.slice(startIndex, endIndex), startIndex };
}

/**
 * Redact refs in text: replace the ref at [excludeStart, excludeEnd) with empty string,
 * replace all other refs with [REF].
 */
function redactOtherRefs(text, excludeStart, excludeEnd) {
  const refRegex = /<ref[\s\S]*?<\/ref\s*>|<ref[^>]*\/\s*>/gi;
  let result = '';
  let lastEnd = 0;
  let match;
  while ((match = refRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;
    result += text.slice(lastEnd, matchStart);
    if (matchStart >= excludeStart && matchEnd <= excludeEnd) {
      result += '';
    } else if (matchStart < excludeEnd && matchEnd > excludeStart) {
      result += '';
    } else {
      result += '[REF]';
    }
    lastEnd = matchEnd;
  }
  result += text.slice(lastEnd);
  return result;
}

/**
 * Strip wiki markup for display (remove [[link]], ''italic'', {{templates}}, etc.)
 */
function stripWikiMarkup(text) {
  let result = text
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/''([^']*)''/g, '$1')
    .replace(/'{2,3}([^']*)'{2,3}/g, '$1')
    .replace(/<[^>]+>/g, '');

  // Remove {{...}} templates (including nested like {{!}}) by repeatedly stripping innermost
  while (result.includes('{{')) {
    const next = result.replace(/\{\{[^{}]*\}\}/g, '');
    if (next === result) break;
    result = next;
  }

  return result.trim();
}

/**
 * Split source into sections by == Header ==
 */
function splitSections(source) {
  const sections = [];
  const headerRegex = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/gm;
  let lastEnd = 0;
  let prevName = 'Introduction';
  let match;

  while ((match = headerRegex.exec(source)) !== null) {
    const headerEnd = match.index + match[0].length;
    const content = source.slice(lastEnd, match.index);
    if (content.trim()) {
      sections.push({ name: prevName, content });
    }
    prevName = match[2].trim();
    lastEnd = headerEnd;
  }

  if (lastEnd < source.length) {
    sections.push({ name: prevName, content: source.slice(lastEnd) });
  }

  return sections;
}

/**
 * Parse a single page source and extract all citations.
 * @param {string} source - Raw wiki markup
 * @param {string} articleTitle - Article title
 * @param {number} priorSentences - Number of prior sentences to include
 * @param {Set<string>} whitelistTypes - Citation types to include (e.g. web, news)
 * @returns {Array<{ type, link, blurb, sentence, article_title, section }>}
 */
function parseRefs(source, articleTitle, priorSentences = 1, whitelistTypes = null) {
  const results = [];
  const sections = splitSections(source);

  for (const section of sections) {
    const sectionContent = section.content;
    const refs = findAllRefs(sectionContent);

    for (const ref of refs) {
      if (!ref.content || ref.content.length < 5) continue;

      const parsed = parseCiteTemplate(ref.content);
      if (!parsed) continue;
      if (whitelistTypes && !whitelistTypes.has(parsed.type)) continue;
      if (!parsed.url || !parsed.url.startsWith('http')) continue;

      const absStart = source.indexOf(sectionContent) + ref.start;
      const absEnd = source.indexOf(sectionContent) + ref.end;

      const { text: rawSentence, startIndex } = extractSurroundingSentence(
        sectionContent,
        ref.start,
        ref.end,
        priorSentences
      );
      const relStart = ref.start - startIndex;
      const relEnd = ref.end - startIndex;
      const sentenceWithRedacted = redactOtherRefs(rawSentence, relStart, relEnd);
      const cleanSentence = stripWikiMarkup(sentenceWithRedacted);

      results.push({
        type: parsed.type,
        link: parsed.url,
        blurb: parsed.blurb,
        sentence: cleanSentence,
        article_title: articleTitle,
        section: section.name,
      });
    }
  }

  return results;
}

export { parseRefs, findAllRefs, splitSections, parseCiteTemplate };
