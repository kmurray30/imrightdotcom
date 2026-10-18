/**
 * Cited-span extraction from Wikimedia Enterprise's rendered article HTML
 * (`article_body.html`, Parsoid output). This replaces the wikitext regex
 * approach: in the HTML every citation marker sits at its exact position in
 * the text, named/reused refs are already resolved to one reference-list
 * entry, lists/tables/captions/infoboxes/notes are real structure, and each
 * reference entry carries the citation template's parameters (url, title,
 * archive-url…) in its data-mw attribute.
 *
 * Unit of output: a SPAN = the text between consecutive citation groups
 * inside one paragraph (or list item / table row, when enabled), with the
 * citations of the group that ends it. This is Wikipedia's own convention
 * (WP:CITE, text–source integrity): an inline citation supports the material
 * back to the previous citation, within the sentence/paragraph it sits in.
 * Rules, decided with the data in the plan:
 *  - adjacent markers separated only by whitespace/punctuation form ONE group
 *    (stacked citations): one span, all their citations kept;
 *  - a marker inside a sentence ends the span there; the rest of the sentence
 *    belongs to the next group or is dropped if nothing cites it;
 *  - text after a unit's last group is dropped (uncited); so is a span whose
 *    boundary is a {{citation needed}}-style tag, a span whose refs have no
 *    http URL (notes, {{sfn}} footnotes, book refs without links), and a span
 *    under MIN_SPAN_WORDS / MIN_SPAN_CHARS;
 *  - explanatory notes (ref group=…) are not citations: their marker text is
 *    removed and the span continues;
 *  - a span never crosses into a previous paragraph.
 *
 * Nothing uncited is returned.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MIN_SPAN_WORDS = 6;
export const MIN_SPAN_CHARS = 40;

/** Sections whose content is navigation or sourcing apparatus, never claims to cite. */
export const SKIPPED_SECTIONS =
  /^(references?|notes?( and references)?|footnotes?|citations?|sources?|bibliography|external links?|see also|further reading|works cited|gallery|references and notes|notes and citations)$/i;

// Containers whose text is never article prose: boxes, navigation, media
// captions, the reference list itself. A unit with one of these as an
// ancestor is skipped.
const EXCLUDED_ANCESTORS = [
  'table.infobox', 'table.sidebar', 'table.metadata', 'table.ambox', 'table.navbox', 'table.vertical-navbox',
  'div.navbox', '[role="navigation"]', '.hatnote', '[role="note"]', 'figure', 'figcaption', '.thumbcaption',
  '.gallery', '.mw-references-wrap', 'ol.references', 'ol.mw-references', '.reflist', '.toc', '.mw-editsection',
  '.mbox-small', '.sistersitebox', '.quotebox', '.side-box', '[typeof~="mw:Image"]', 'figure-inline',
].join(', ');

// Elements dropped from the text entirely (no span boundary).
const DROPPED_ELEMENTS = [
  'style', 'script', '.mw-editsection', '.mw-cite-backlink', '[typeof~="mw:Image"]', 'figure-inline', 'figure',
  '.noexcerpt', '.mw-empty-elt', 'span.mw-reflink-text', '.reference-accessdate', 'link', 'meta',
].join(', ');

// {{citation needed}} and friends: the text before them has no source.
const UNSOURCED_TAG_TEMPLATES = new Set([
  'citation needed', 'cn', 'fact', 'cite needed', 'cite-needed', 'citation-needed', 'source needed', 'ref needed',
  'refneeded', 'citationneeded', 'citation needed span', 'unreferenced', 'uncited',
]);

const ARCHIVE_HOST = /(^|\.)(web\.archive\.org|archive\.(org|today|ph|is|li|vn|fo|md))$/i;

const refExtractorConfigPath = path.join(__dirname, '..', 'ref_extractor', 'config.yaml');
const refExtractorConfig = fs.existsSync(refExtractorConfigPath) ? yaml.parse(fs.readFileSync(refExtractorConfigPath, 'utf8')) : {};
/** Same paywall / low-quality host list ref_extractor uses (case-insensitive substring match on the URL). */
export const EXCLUDED_URL_PATTERNS = (refExtractorConfig.exclude_url_patterns ?? []).map((p) => String(p).toLowerCase());

export function isExcludedUrl(url) {
  const lower = String(url ?? '').toLowerCase();
  return EXCLUDED_URL_PATTERNS.some((pattern) => lower.includes(pattern));
}

function parseDataMw(el) {
  const raw = el.attribs?.['data-mw'];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Template transclusions in a data-mw payload: [{ name, params: { lowerName: value } }]. */
function templatesIn(dataMw) {
  const out = [];
  for (const part of dataMw?.parts ?? []) {
    const template = part?.template;
    if (!template) continue;
    const name = String(template.target?.wt ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const params = {};
    for (const [key, value] of Object.entries(template.params ?? {})) {
      params[key.trim().toLowerCase()] = String(value?.wt ?? value?.html ?? '').trim();
    }
    out.push({ name, params });
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function firstParam(params, names) {
  for (const name of names) if (params[name]) return params[name];
  return null;
}

/**
 * Citations in one reference-list entry (`<li id="cite_note-…">`). One
 * entry can hold several {{cite}} templates (rare) — each becomes a citation.
 * Returns only citations with an http(s) URL that isn't on the exclude list.
 */
function citationsFromReferenceEntry($, li) {
  const body = li.find('.mw-reference-text, .reference-text').first();
  const scope = body.length ? body : li;
  const citations = [];

  const addCitation = (c) => {
    let url = c.url && /^https?:\/\//i.test(c.url) ? c.url : null;
    let archiveUrl = c.archive_url && /^https?:\/\//i.test(c.archive_url) ? c.archive_url : null;
    if (!url && archiveUrl) url = archiveUrl; // dead original: the archive is the only working link
    if (!url || isExcludedUrl(url)) return;
    if (citations.some((existing) => existing.url === url)) return;
    citations.push({
      type: c.type || 'url',
      url,
      archive_url: archiveUrl && archiveUrl !== url ? archiveUrl : null,
      title: c.title || null,
      publisher: c.publisher || null,
      date: c.date || null,
    });
  };

  // 1. Citation templates, from data-mw on any transclusion in the entry
  //    (Parsoid puts the parameters there verbatim).
  const seenTemplates = new Set();
  scope.find('[data-mw]').addBack('[data-mw]').each((_, el) => {
    for (const { name, params } of templatesIn(parseDataMw(el))) {
      const citeMatch = /^(?:cite\s+([a-z-]+)|citation)$/.exec(name);
      if (!citeMatch) continue;
      const key = JSON.stringify(params);
      if (seenTemplates.has(key)) continue;
      seenTemplates.add(key);
      addCitation({
        type: citeMatch[1] ?? 'citation',
        url: firstParam(params, ['url', 'chapter-url', 'chapterurl', 'article-url']),
        archive_url: firstParam(params, ['archive-url', 'archiveurl']),
        title: firstParam(params, ['title', 'chapter', 'trans-title']),
        publisher: firstParam(params, ['work', 'website', 'newspaper', 'journal', 'magazine', 'publisher', 'encyclopedia', 'periodical', 'agency']),
        date: firstParam(params, ['date', 'year', 'publication-date']),
      });
    }
  });
  if (citations.length) return citations;

  // 2. No usable template data: fall back to the rendered <cite> element(s).
  scope.find('cite').each((_, citeEl) => {
    const cite = $(citeEl);
    const classes = (cite.attr('class') ?? '').split(/\s+/).filter(Boolean);
    const type = classes.includes('citation') ? classes.find((c) => c !== 'citation' && !/^cs[12]$/.test(c) && !c.startsWith('cs1-')) ?? 'citation' : 'url';
    const links = cite.find('a[href^="http"]').toArray().map((a) => $(a).attr('href'));
    const archive = links.find((href) => ARCHIVE_HOST.test(hostOf(href)));
    const url = links.find((href) => !ARCHIVE_HOST.test(hostOf(href))) ?? archive ?? null;
    const titleAnchor = cite.find('a[href^="http"]').first();
    addCitation({ type, url, archive_url: archive ?? null, title: titleAnchor.text().replace(/^"|"$/g, '').trim() || null, publisher: cite.find('i').first().text().trim() || null, date: null });
  });
  if (citations.length) return citations;

  // 3. Bare reference: just a link, e.g. <ref>https://example.org</ref>.
  const links = scope.find('a[href^="http"]').toArray().map((a) => ({ href: $(a).attr('href'), text: $(a).text().trim() }));
  const archive = links.find((l) => ARCHIVE_HOST.test(hostOf(l.href)));
  const primary = links.find((l) => !ARCHIVE_HOST.test(hostOf(l.href))) ?? archive;
  if (primary) addCitation({ type: 'url', url: primary.href, archive_url: archive?.href ?? null, title: primary.text && primary.text !== primary.href ? primary.text : null });
  return citations;
}

/** Map of reference id (li id, e.g. "cite_note-Smith_2001-2") → citations[] (possibly empty: a note, {{sfn}}, or a book with no link). */
function buildReferenceMap($) {
  const map = new Map();
  $('li[id^="cite_note"]').each((_, li) => {
    const el = $(li);
    map.set(el.attr('id'), citationsFromReferenceEntry($, el));
  });
  return map;
}

function markerInfo($, sup) {
  const dataMw = parseDataMw(sup);
  const text = $(sup).text().trim();
  let refId = dataMw?.body?.id ? String(dataMw.body.id).replace(/^mw-reference-text-/, '') : null;
  if (!refId) {
    const href = $(sup).find('a[href*="#cite_note"]').first().attr('href') ?? '';
    const hash = href.indexOf('#');
    if (hash !== -1) refId = decodeURIComponent(href.slice(hash + 1));
  }
  const group = dataMw?.attrs?.group ?? null;
  // Notes render as "[note 1]", "[a]", "[nb 2]" … citations as "[12]".
  const isNote = Boolean(group) || !/^\[\d+\]$/.test(text);
  return { refId, isNote };
}

function isCitationMarker(el) {
  const cls = ` ${el.attribs?.class ?? ''} `;
  const type = el.attribs?.typeof ?? '';
  return (el.tagName === 'sup' || el.tagName === 'span') && (type.includes('mw:Extension/ref') || cls.includes(' mw-ref ') || cls.includes(' reference '));
}

/** {{citation needed}}-style inline tag → boundary with no source; other inline tags ([when?], [who?]) → dropped text. */
function inlineTagKind(el) {
  const cls = ` ${el.attribs?.class ?? ''} `;
  if (!cls.includes(' Inline-Template ') && !cls.includes(' Template-Fact ') && !(el.attribs?.typeof ?? '').includes('mw:Transclusion')) return null;
  if (cls.includes(' Template-Fact ')) return 'unsourced';
  for (const { name } of templatesIn(parseDataMw(el))) {
    if (UNSOURCED_TAG_TEMPLATES.has(name)) return 'unsourced';
  }
  return cls.includes(' Inline-Template ') ? 'drop' : null;
}

/**
 * Flattens one content unit into an ordered list of segments:
 * { text } | { marker: { refId, isNote } } | { unsourced: true }.
 */
function segmentsOf($, unit, options) {
  const segments = [];
  const visit = (node) => {
    if (node.type === 'text') {
      segments.push({ text: node.data });
      return;
    }
    if (node.type !== 'tag') return;
    if (options.skipNestedLists && (node.tagName === 'ul' || node.tagName === 'ol' || node.tagName === 'dl')) return;
    if (isCitationMarker(node)) {
      segments.push({ marker: markerInfo($, node) });
      return;
    }
    const tagKind = inlineTagKind(node);
    if (tagKind === 'unsourced') {
      segments.push({ unsourced: true });
      return;
    }
    if (tagKind === 'drop') return;
    if ($(node).is(DROPPED_ELEMENTS)) return;
    if (node.tagName === 'br') {
      segments.push({ text: ' ' });
      return;
    }
    if ((node.attribs?.typeof ?? '').includes('mw:Extension/math')) {
      const alt = $(node).find('img[alt]').attr('alt') ?? $(node).text();
      segments.push({ text: ` ${alt} ` });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of unit.children ?? []) visit(child);
  return segments;
}

const normalize = (text) => text.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
const countWords = (text) => (text.match(/\S+/g) ?? []).length;
/** Only whitespace/punctuation between two markers → they're stacked on the same spot. */
const STACK_GAP = /^[\s,;.–—)\]]*$/;

/** Splits one unit's segments into candidate spans: [{ text, refIds: [] }]. Uncited tails and {{cn}}-bounded text are dropped here. */
function spansFromSegments(segments) {
  const spans = [];
  let pending = '';
  let open = null; // the span whose citation group is still accepting stacked markers
  for (const segment of segments) {
    if (segment.text !== undefined) {
      pending += segment.text;
      continue;
    }
    if (segment.unsourced) {
      pending = '';
      open = null;
      continue;
    }
    const { refId, isNote } = segment.marker;
    if (isNote) continue; // note marker text is simply removed; the span continues
    if (open && STACK_GAP.test(pending)) {
      open.text += pending; // keep the punctuation between stacked markers
      pending = '';
      if (refId) open.refIds.push(refId);
      continue;
    }
    open = { text: pending, refIds: refId ? [refId] : [] };
    spans.push(open);
    pending = '';
  }
  return spans; // `pending` here is the uncited tail: dropped
}

function headingText($, el) {
  const clone = $(el).clone();
  clone.find('.mw-editsection').remove();
  return normalize(clone.text());
}

/**
 * @param {string} html - Parsoid HTML of one article (article_body.html).
 * @param {object} [options]
 * @param {boolean} [options.includeListItems=false]
 * @param {boolean} [options.includeTableRows=false]
 * @param {number} [options.minWords=MIN_SPAN_WORDS]
 * @param {number} [options.minChars=MIN_SPAN_CHARS]
 * @returns {{ spans: Array<{section:string, kind:string, unitIndex:number, spanIndex:number, text:string, citations:Array}>, stats: object }}
 */
export function analyzeArticleHtml(html, options = {}) {
  const opts = { includeListItems: false, includeTableRows: false, minWords: MIN_SPAN_WORDS, minChars: MIN_SPAN_CHARS, ...options };
  const $ = cheerio.load(html ?? '');
  const refMap = buildReferenceMap($);
  const stats = {
    units: { paragraph: 0, list_item: 0, table_row: 0 },
    citedUnits: { paragraph: 0, list_item: 0, table_row: 0 },
    unitChars: { paragraph: 0, list_item: 0, table_row: 0 },
    spansKept: { paragraph: 0, list_item: 0, table_row: 0 },
    spanChars: { paragraph: 0, list_item: 0, table_row: 0 },
    spansDroppedShort: 0,
    spansDroppedNoUsableCitation: 0,
    uncitedTailChars: 0,
    unsourcedTagBoundaries: 0,
    markers: 0,
    noteMarkers: 0,
    stackedGroups: 0,
    references: refMap.size,
    referencesWithoutUrl: [...refMap.values()].filter((c) => c.length === 0).length,
    citationTypes: {},
    skippedSectionUnits: 0,
  };
  const spans = [];
  const unitCounters = { paragraph: 0, list_item: 0, table_row: 0 };

  const headings = []; // stack of { level, name }
  const currentSection = () => (headings.length ? headings[headings.length - 1].name : 'Introduction');
  const inSkippedSection = () => headings.some((h) => SKIPPED_SECTIONS.test(h.name));

  const emitUnit = (kind, unitEl, text, segments) => {
    const section = currentSection();
    if (inSkippedSection()) {
      stats.skippedSectionUnits++;
      return;
    }
    const unitIndex = unitCounters[kind]++;
    stats.units[kind]++;
    const unitText = normalize(text);
    stats.unitChars[kind] += unitText.length;
    const markers = segments.filter((s) => s.marker);
    stats.markers += markers.length;
    stats.noteMarkers += markers.filter((s) => s.marker.isNote).length;
    stats.unsourcedTagBoundaries += segments.filter((s) => s.unsourced).length;
    if (!markers.some((s) => !s.marker.isNote)) return;
    stats.citedUnits[kind]++;

    const candidates = spansFromSegments(segments);
    let spanIndex = 0;
    let keptChars = 0;
    for (const candidate of candidates) {
      if (candidate.refIds.length > 1) stats.stackedGroups++;
      const text = normalize(candidate.text);
      const citations = [];
      for (const refId of candidate.refIds) {
        for (const c of refMap.get(refId) ?? []) if (!citations.some((e) => e.url === c.url)) citations.push(c);
      }
      if (citations.length === 0) {
        stats.spansDroppedNoUsableCitation++;
        continue;
      }
      if (countWords(text) < opts.minWords || text.length < opts.minChars) {
        stats.spansDroppedShort++;
        continue;
      }
      for (const c of citations) stats.citationTypes[c.type] = (stats.citationTypes[c.type] ?? 0) + 1;
      spans.push({ section, kind, unitIndex, spanIndex: spanIndex++, text, citations });
      stats.spansKept[kind]++;
      stats.spanChars[kind] += text.length;
      keptChars += text.length;
    }
    stats.uncitedTailChars += Math.max(0, unitText.length - keptChars);
  };

  const unitSelector = ['h2', 'h3', 'h4', 'h5', 'h6', 'p', opts.includeListItems ? 'li' : null, opts.includeTableRows ? 'tr' : null].filter(Boolean).join(', ');
  $('body').find(unitSelector).each((_, el) => {
    const node = $(el);
    if (/^h[2-6]$/.test(el.tagName)) {
      const level = Number(el.tagName[1]);
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, name: headingText($, el) || `Section ${level}` });
      return;
    }
    if (node.parents(EXCLUDED_ANCESTORS).length) return;
    if (el.tagName === 'p') {
      if (node.parents('li, td, th').length) return; // counted (or not) as part of its list item / table row
      const segments = segmentsOf($, el, {});
      const text = segments.map((s) => s.text ?? '').join('');
      if (!text.trim()) return;
      emitUnit('paragraph', el, text, segments);
      return;
    }
    if (el.tagName === 'li') {
      if (node.parents('ol.references, ol.mw-references, .mw-references-wrap, .reflist').length) return;
      const segments = segmentsOf($, el, { skipNestedLists: true });
      const text = segments.map((s) => s.text ?? '').join('');
      if (!text.trim()) return;
      emitUnit('list_item', el, text, segments);
      return;
    }
    if (el.tagName === 'tr') {
      const cells = node.children('td, th');
      if (!cells.length || !node.children('td').length) return; // header-only row
      const table = node.closest('table');
      const headers = table.find('tr').first().children('th').toArray().map((th) => normalize($(th).text()));
      const segments = [];
      cells.each((i, cell) => {
        const label = headers[i] && headers.length === cells.length ? `${headers[i]}: ` : '';
        if (i > 0) segments.push({ text: '; ' });
        if (label) segments.push({ text: label });
        segments.push(...segmentsOf($, cell, { skipNestedLists: false }));
      });
      // A row is one claim: every marker in it forms a single group at the end.
      const rowMarkers = segments.filter((s) => s.marker);
      const rowText = segments.filter((s) => s.text !== undefined).map((s) => s.text).join('');
      if (!rowText.trim()) return;
      const flattened = [{ text: rowText }, ...rowMarkers.map((m, i) => (i === 0 ? m : { ...m, stacked: true }))];
      emitUnit('table_row', el, rowText, flattened);
    }
  });

  return { spans, stats };
}

/**
 * The build's entry point: cited spans for one Wikimedia Enterprise article.
 * @param {{ name?: string, article_body?: { html?: string } }|string} article - Enterprise article model, or raw HTML.
 */
export function extractCitedSpans(article, options = {}) {
  const html = typeof article === 'string' ? article : article?.article_body?.html;
  if (!html) return [];
  return analyzeArticleHtml(html, options).spans;
}
