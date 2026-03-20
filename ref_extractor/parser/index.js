/**
 * Parses Wikipedia source to extract citations with surrounding context.
 * Handles <ref>...</ref>, named refs, and {{cite X|...}} templates.
 */

import { parseAllCiteTemplates, parseCiteTemplate } from './citeTemplate.js';

// Wikipedia <ref> tag patterns
const REF_OPEN = /<ref(?:\s+name\s*=\s*["']?([^"'>\s]+)["']?)?\s*>/gi;      // <ref> or <ref name="X">
const REF_CLOSE = /<\/ref\s*>/gi;
const REF_SELF_CLOSING = /<ref(?:\s+name\s*=\s*["']?([^"'>\s]+)["']?)?\s*\/\s*>/gi;  // <ref name="X" />

const SENTENCE_END = /[.!?]+[\s\n]+/g;  // Sentence boundaries (period/question/exclamation + whitespace)

/**
 * Find all ref tags and their positions. Returns array of { name, content, start, end }.
 * First pass: collect definitions. Second pass: expand named refs (e.g. <ref name="X" />).
 */
function findAllRefs(source) {
  const namedRefs = new Map();  // name -> content for <ref name="X">...</ref> definitions
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

  // Pair each <ref>...</ref> with its matching </ref>
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

  // Expand named self-closing refs: <ref name="X" /> -> content from definition
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
 * Check if position is inside any ref range.
 */
function isInsideRef(position, refRanges) {
  for (const range of refRanges) {
    if (position >= range.start && position < range.end) return true;
  }
  return false;
}

/**
 * Extract the sentence(s) containing the ref. priorSentences = how many sentences before the ref to include.
 * Skips sentence boundaries that fall inside refs (avoids orphaned template content like |url= in output).
 * @param {Array<{start: number, end: number}>} refRanges - Ref ranges in source coords (to exclude boundaries inside refs)
 */
function extractSurroundingSentence(source, refStart, refEnd, priorSentences = 1, refRanges = []) {
  const beforeRef = source.slice(0, refStart);
  const afterRef = source.slice(refEnd);

  // Find where each sentence starts (right after . ! ?), but skip boundaries inside refs
  const sentenceStarts = [];
  let match;
  const beforeRegex = new RegExp(SENTENCE_END.source, 'g');
  while ((match = beforeRegex.exec(beforeRef)) !== null) {
    const boundaryPos = match.index + match[0].length;
    if (!isInsideRef(boundaryPos, refRanges)) {
      sentenceStarts.push(boundaryPos);
    }
  }

  // Start N sentences back from the ref
  const startIndex =
    sentenceStarts.length >= priorSentences
      ? sentenceStarts[sentenceStarts.length - priorSentences]
      : 0;

  // End at the next sentence boundary after the ref (or ~50 chars if none).
  // When a boundary falls inside a *later* ref (e.g. period in "example.com" in the next cite),
  // end at the start of that ref instead of extending past it—otherwise we'd return the same
  // giant paragraph for every citation in a section.
  const afterRegex = /[.!?]+[\s\n]+/g;
  let endOffset = Math.min(50, afterRef.length);
  let searchStart = 0;
  while (true) {
    afterRegex.lastIndex = 0;
    const searchText = afterRef.slice(searchStart);
    const afterMatch = afterRegex.exec(searchText);
    if (!afterMatch) break;
    const boundaryPos = refEnd + searchStart + afterMatch.index + afterMatch[0].length;
    const candidateEndOffset = searchStart + afterMatch.index + afterMatch[0].length;
    const containingRef = refRanges.find((r) => boundaryPos >= r.start && boundaryPos < r.end);
    if (containingRef && containingRef.start >= refEnd) {
      // Boundary is inside a later ref—end right before it (don't include any of that ref)
      endOffset = containingRef.start - refEnd;
      break;
    }
    endOffset = candidateEndOffset;
    break;
  }
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
    // Target ref (the one we're extracting): remove it entirely (citation shown separately)
    if (matchStart >= excludeStart && matchEnd <= excludeEnd) {
      result += '';
    } else if (matchStart < excludeEnd && matchEnd > excludeStart) {
      result += '';  // overlapping: treat as target
    } else {
      result += '[REF]';  // other refs: placeholder so we don't show their content
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
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')   // [[link]] or [[link|text]] -> text
    .replace(/''([^']*)''/g, '$1')                     // ''italic'' -> italic
    .replace(/'{2,3}([^']*)'{2,3}/g, '$1')             // '''bold''' -> bold
    .replace(/<[^>]+>/g, '');                           // HTML tags -> remove

  // Remove {{...}} templates (including nested like {{!}}) by repeatedly stripping innermost
  while (result.includes('{{')) {
    const next = result.replace(/\{\{[^{}]*\}\}/g, '');
    if (next === result) break;
    result = next;
  }

  return result.trim();
}

/**
 * Split source into sections by == Header == (Wikipedia section headers).
 * Returns [{ name, content }]. Content is the text between headers (not including the header line).
 */
function splitSections(source) {
  const sections = [];
  const headerRegex = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/gm;  // == Title ==, === Subsection ===, etc.
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
 * Find which section a position (character offset) falls into.
 * Sections are [{ start, end, name, content }] with source positions.
 */
function findSectionForPosition(sectionsWithRanges, position) {
  for (const section of sectionsWithRanges) {
    if (position >= section.start && position < section.end) {
      return section;
    }
  }
  return sectionsWithRanges[sectionsWithRanges.length - 1] ?? { name: 'Introduction', content: '', start: 0, end: 0 };
}

/**
 * Parse a single page source and extract all citations.
 * Uses full source for ref discovery (splitSections drops header lines and loses refs).
 * @param {string} source - Raw wiki markup
 * @param {string} articleTitle - Article title
 * @param {number} priorSentences - Number of prior sentences to include
 * @param {Set<string>} whitelistTypes - Citation types to include (e.g. web, news)
 * @returns {Array<{ type, link, blurb, sentence, article_title, section }>}
 */
function parseRefs(source, articleTitle, priorSentences = 1, whitelistTypes = null) {
  const results = [];

  // Build sections with source positions (start/end) so we can map ref positions to sections
  const headerRegex = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/gm;
  let lastEnd = 0;
  let prevName = 'Introduction';
  const sectionsWithRanges = [];
  let match;
  while ((match = headerRegex.exec(source)) !== null) {
    const headerEnd = match.index + match[0].length;
    const content = source.slice(lastEnd, match.index);
    if (content.trim()) {
      sectionsWithRanges.push({
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
    sectionsWithRanges.push({
      name: prevName,
      content: source.slice(lastEnd),
      start: lastEnd,
      end: source.length,
    });
  }

  const refs = findAllRefs(source);

  for (const ref of refs) {
    if (!ref.content || ref.content.length < 5) continue;

    const parsedList = parseAllCiteTemplates(ref.content);
    if (parsedList.length === 0) continue;

    // Map ref position (in full source) to section, then get position within section content
    const section = findSectionForPosition(sectionsWithRanges, ref.start);
    const relStart = ref.start - section.start;
    const relEnd = ref.end - section.start;

    // Ref ranges in section-relative coords (to skip sentence boundaries inside refs)
    const refRangesInSection = refs
      .filter((r) => r.start < section.end && r.end > section.start)
      .map((r) => ({ start: r.start - section.start, end: r.end - section.start }));

    const { text: rawSentence, startIndex } = extractSurroundingSentence(
      section.content,
      relStart,
      relEnd,
      priorSentences,
      refRangesInSection
    );
    const sentenceRelStart = relStart - startIndex;
    const sentenceRelEnd = relEnd - startIndex;
    const sentenceWithRedacted = redactOtherRefs(rawSentence, sentenceRelStart, sentenceRelEnd);
    const cleanSentence = stripWikiMarkup(sentenceWithRedacted);

    for (const parsed of parsedList) {
      results.push({
        type: parsed.type,
        link: parsed.url ?? null,
        blurb: parsed.blurb,
        sentence: cleanSentence,
        article_title: articleTitle,
        section: section.name,
      });
    }
  }

  return results;
}

/** Replace all refs in text with [REF]. */
function redactAllRefs(text) {
  return redactOtherRefs(text, -1, -1);
}

export { parseRefs, findAllRefs, splitSections, parseCiteTemplate, stripWikiMarkup, redactAllRefs };
