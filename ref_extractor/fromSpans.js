/**
 * Citation candidates from cited spans (wiki_searcher/providers/spans.js),
 * the span-search counterpart of searchThenExtract.js's per-article
 * extraction: same candidate shape, same type and URL filters. A span's text
 * is the claim its citations support, so it becomes each candidate's
 * `content`.
 *
 * Each span's first usable citation comes first, in span order; its other
 * citations follow after all of those, as fallbacks (a later round picks them
 * up when earlier links are dead). Otherwise a span with three citations
 * would fill three of a term's slots with the same claim.
 *
 * @param {Array<{ title: string, text: string, score?: number, citations: object[] }>} spans - Best first.
 * @param {{ citationTypes: Set<string>, excludeUrlPatterns: string[] }} options - Lower-cased, as extract() builds them.
 * @returns {Array<{ link: string, archiveLink: string|null, title: string, content: string, article_title: string }>}
 */
export function citationsFromSpans(spans, { citationTypes, excludeUrlPatterns }) {
  const firsts = [];
  const rest = [];
  for (const span of spans) {
    let isFirst = true;
    for (const citation of span.citations ?? []) {
      if (!citation.url) continue;
      if (!citationTypes.has(String(citation.type ?? '').toLowerCase())) continue;
      const linkLower = citation.url.toLowerCase();
      if (excludeUrlPatterns.some((pattern) => linkLower.includes(pattern))) continue;
      (isFirst ? firsts : rest).push({
        link: citation.url,
        archiveLink: citation.archive_url ?? null,
        title: (citation.title || [citation.publisher, citation.date].filter(Boolean).join(' - ')).slice(0, 500),
        content: span.text,
        article_title: span.title,
      });
      isFirst = false;
    }
  }
  return [...firsts, ...rest];
}
