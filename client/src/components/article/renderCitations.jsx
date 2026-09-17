/**
 * React port of tabloid_generator/index.js's processParagraphWithLinks:
 * `[anchor text](N)` markers become citation links, `N` resolved against the
 * article's own citations array (1-based `id`). React escapes text nodes
 * automatically, so there's no manual escapeHtml step here.
 */
const LINK_PATTERN = /\[([^\]]+)\]\((\d+)\)/g;

export function renderParagraphWithCitations(text, citations) {
  const citationById = new Map((citations ?? []).map((c) => [c.id, c]));
  const nodes = [];
  let lastIndex = 0;
  let match;
  let key = 0;
  LINK_PATTERN.lastIndex = 0;
  while ((match = LINK_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [, anchor, idRaw] = match;
    const citation = citationById.get(Number(idRaw));
    if (citation?.link) {
      nodes.push(
        <a key={key++} href={citation.link} className="citation-link" target="_blank" rel="noopener noreferrer">
          {anchor}
          <sup>[{citation.id}]</sup>
        </a>
      );
    } else {
      nodes.push(anchor);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function paragraphText(paragraph) {
  return typeof paragraph === 'string' ? paragraph : (paragraph?.text ?? '');
}
