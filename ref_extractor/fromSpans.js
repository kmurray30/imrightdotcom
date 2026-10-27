/**
 * Citation candidates from cited spans (wiki_searcher/providers/spans.js),
 * the span-search counterpart of searchThenExtract.js's per-article
 * extraction: same candidate shape, same type and URL filters. A span's text
 * is the claim its citations support, so it becomes each candidate's
 * `content`.
 *
 * @param {Array<{ title: string, text: string, score?: number, citations: object[] }>} spans - Best first.
 * @param {{ citationTypes: Set<string>, excludeUrlPatterns: string[] }} options - Lower-cased, as extract() builds them.
 * @returns {Array<{ link: string, archiveLink: string|null, title: string, content: string, article_title: string }>} In span order.
 */
export function citationsFromSpans(spans, { citationTypes, excludeUrlPatterns }) {
  const candidates = [];
  for (const span of spans) {
    for (const citation of span.citations ?? []) {
      if (!citation.url) continue;
      if (!citationTypes.has(String(citation.type ?? '').toLowerCase())) continue;
      const linkLower = citation.url.toLowerCase();
      if (excludeUrlPatterns.some((pattern) => linkLower.includes(pattern))) continue;
      candidates.push({
        link: citation.url,
        archiveLink: citation.archive_url ?? null,
        title: (citation.title || [citation.publisher, citation.date].filter(Boolean).join(' - ')).slice(0, 500),
        content: span.text,
        article_title: span.title,
      });
    }
  }
  return candidates;
}
