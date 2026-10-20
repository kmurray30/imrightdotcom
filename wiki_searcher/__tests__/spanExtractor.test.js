/**
 * Unit tests for wiki_searcher/spanExtractor.js against a hand-built
 * Parsoid-style article (fixtures/parsoid-sample.html) that exercises every
 * rule from the plan. Real Enterprise records (fixtures/enterprise-sample.ndjson,
 * written by scripts/sample-article-structure.js) get their own checks below
 * once that file exists.
 *
 * Run: node --test wiki_searcher/__tests__/spanExtractor.test.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { analyzeArticleHtml, extractCitedSpans, extractSpans, isOnlineCitation } from '../spanExtractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'parsoid-sample.html'), 'utf8');

const byText = (spans, needle) => spans.find((s) => s.text.includes(needle));

describe('extractCitedSpans — paragraphs (default options)', () => {
  const spans = extractCitedSpans({ name: 'Test Article', article_body: { html } });
  const { unembedded } = extractSpans({ name: 'Test Article', article_body: { html } });

  test('keeps exactly the cited, long-enough spans', () => {
    assert.deepStrictEqual(
      spans.map((s) => s.text),
      [
        'Test Article is a lead paragraph with a single citation at the end of the first sentence.',
        'It then continues with a second sentence and a third one that share one citation at the end.',
        'Stacked citations support this first sentence of the history section fully.',
        'A mid-sentence citation covers only the words before it,',
        'Finally a properly cited closing sentence rounds out the paragraph with enough words.',
      ]
    );
  });

  test('resolves a named ref with a space in its name', () => {
    const span = byText(spans, 'lead paragraph with a single citation');
    assert.deepStrictEqual(span.citations, [
      {
        type: 'news',
        url: 'https://example.com/smith',
        archive_url: 'https://web.archive.org/web/20200101000000/https://example.com/smith',
        title: 'Smith title',
        publisher: 'The Paper',
        date: '2001-05-01',
      },
    ]);
  });

  test('stacked markers form one group with all citations', () => {
    const span = byText(spans, 'Stacked citations');
    assert.deepStrictEqual(
      span.citations.map((c) => [c.type, c.url]),
      [
        ['journal', 'https://journals.example.edu/article/3'],
        ['book', 'https://books.google.com/books?id=abc'],
      ]
    );
  });

  test('a mid-sentence marker ends the span; the uncited remainder and tail are dropped', () => {
    const span = byText(spans, 'mid-sentence');
    assert.strictEqual(span.text, 'A mid-sentence citation covers only the words before it,');
    assert.deepStrictEqual(span.citations, [{ type: 'url', url: 'https://example.net/bare', archive_url: null, title: null, publisher: null, date: null }]);
    assert.ok(!spans.some((s) => s.text.includes('no source at all')));
    assert.ok(!spans.some((s) => s.text.includes('nobody cites')));
  });

  test('a span cited only by a short footnote is stored unembedded, resolved to its bibliography entry', () => {
    assert.ok(!spans.some((s) => s.text.includes('shortened footnote')));
    const span = unembedded.find((s) => s.text.includes('shortened footnote'));
    assert.strictEqual(span.reason, 'no_online_citation');
    assert.deepStrictEqual(span.citations, [
      { type: 'book', url: null, archive_url: null, title: 'Old Book', publisher: 'Old Press', date: '1950', text: 'Old Author 1950, p. 5. — Old Author (1950). Old Book. Old Press.' },
    ]);
  });

  test('{{citation needed}} is a boundary: the tagged claim is dropped', () => {
    assert.ok(!spans.some((s) => s.text.includes('unsourced and tagged')));
  });

  test('a note marker does not count; a paywalled-only span is stored unembedded with the url flagged', () => {
    assert.ok(!spans.some((s) => s.text.includes('paywalled source only')));
    assert.ok(!spans.some((s) => s.citations.some((c) => c.url?.includes('jstor.org'))));
    const span = unembedded.find((s) => s.text.includes('paywalled source only'));
    assert.strictEqual(span.reason, 'no_online_citation');
    assert.strictEqual(span.citations.length, 1, 'the explanatory note is not a citation');
    assert.strictEqual(span.citations[0].url, 'https://www.jstor.org/stable/123');
    assert.strictEqual(span.citations[0].excluded, true);
    assert.strictEqual(span.citations[0].text, '"Paywalled".');
  });

  test('other inline tags ([when?]) vanish from the text without splitting the span', () => {
    const span = byText(spans, 'properly cited closing sentence');
    assert.strictEqual(span.text, 'Finally a properly cited closing sentence rounds out the paragraph with enough words.');
    assert.deepStrictEqual(span.citations.map((c) => c.url), ['https://example.com/eight']);
    assert.strictEqual(span.citations[0].publisher, 'Example');
  });

  test('too-short spans are stored unembedded', () => {
    assert.ok(!spans.some((s) => s.text === 'Short.'));
    const span = unembedded.find((s) => s.text === 'Short.');
    assert.strictEqual(span.reason, 'short');
    assert.deepStrictEqual(span.citations.map((c) => c.url), ['https://example.com/eight']);
  });

  test('span indices run across embedded and unembedded spans in document order', () => {
    const byUnit = new Map();
    for (const s of [...spans, ...unembedded]) {
      const key = `${s.kind}:${s.unitIndex}`;
      byUnit.set(key, [...(byUnit.get(key) ?? []), s.spanIndex]);
    }
    for (const [unit, indices] of byUnit) {
      assert.deepStrictEqual([...indices].sort((a, b) => a - b), indices.map((_, i) => i), `unit ${unit}: ${indices}`);
    }
    assert.strictEqual(unembedded.find((s) => s.text.includes('shortened footnote')).spanIndex, 2);
  });

  test('infobox, caption, navbox and reference-list text never appear', () => {
    const all = spans.map((s) => s.text).join('\n');
    for (const forbidden of ['infobox cell', 'caption with its own', 'Navbox text', 'Infobox source', 'Old Author']) {
      assert.ok(!all.includes(forbidden), `found "${forbidden}"`);
    }
  });

  test('no marker text or markup leaks into span text', () => {
    for (const s of spans) {
      assert.ok(!/\[\d+\]|\[note|\[edit\]|<|>|\{\{/.test(s.text), s.text);
    }
  });

  test('sections and locators are recorded', () => {
    assert.strictEqual(byText(spans, 'lead paragraph').section, 'Introduction');
    assert.strictEqual(byText(spans, 'Stacked citations').section, 'History');
    const history = spans.filter((s) => s.section === 'History');
    assert.deepStrictEqual(history.map((s) => [s.kind, s.unitIndex, s.spanIndex]), [
      ['paragraph', 1, 0],
      ['paragraph', 1, 1],
      ['paragraph', 2, 1], // index 0 of that paragraph is the paywalled-only span, stored unembedded
    ]);
  });
});

describe('analyzeArticleHtml — lists, tables and stats', () => {
  test('list items are off by default and split like paragraphs when on', () => {
    const off = analyzeArticleHtml(html);
    assert.strictEqual(off.stats.units.list_item, 0);
    const on = analyzeArticleHtml(html, { includeListItems: true });
    const items = on.spans.filter((s) => s.kind === 'list_item');
    assert.deepStrictEqual(items.map((s) => s.text), ['A longer list item that is cited and long enough to be kept as a span of its own.']);
    assert.strictEqual(items[0].section, 'Awards');
    assert.strictEqual(on.stats.units.list_item, 4); // 3 top-level bullets + the nested one (its own unit; its text is excluded from the parent's)
    assert.ok(!items.some((s) => s.text.includes('nested bullet')), 'nested text must not be folded into the parent item');
    assert.strictEqual(on.stats.spansUnembeddedShort >= 1, true); // "Best Picture, 1999"
  });

  test('table rows become "Header: value" spans with the row\'s citations', () => {
    const { spans, stats } = analyzeArticleHtml(html, { includeTableRows: true });
    const rows = spans.filter((s) => s.kind === 'table_row');
    assert.deepStrictEqual(rows.map((s) => s.text), ['Year: 2001; Title: Alpha; Notes: Won the big prize that year']);
    // online book + the short footnote's offline book: embedded (one online citation suffices), both citations kept
    assert.deepStrictEqual(rows[0].citations.map((c) => [c.type, c.url]), [['book', 'https://books.google.com/books?id=abc'], ['book', null]]);
    assert.strictEqual(rows[0].citations[1].text, 'Old Author 1950, p. 5. — Old Author (1950). Old Book. Old Press.');
    assert.strictEqual(stats.units.table_row, 2); // header row excluded; infobox/navbox rows excluded
  });

  test('stats reflect the fixture', () => {
    const { stats } = analyzeArticleHtml(html);
    assert.strictEqual(stats.units.paragraph, 4);
    assert.strictEqual(stats.citedUnits.paragraph, 4);
    assert.strictEqual(stats.references, 9);
    assert.strictEqual(stats.referencesWithoutUrl, 3); // note, sfn, paywall-excluded
    assert.strictEqual(stats.spansUnembeddedNoOnlineCitation, 2); // sfn-only span, paywall-only span
    assert.strictEqual(stats.spansUnembeddedShort, 1); // "Short."
    assert.strictEqual(stats.spansDroppedNoCitation, 0);
    assert.strictEqual(stats.noteMarkers, 1);
    assert.strictEqual(stats.stackedGroups, 1);
    assert.strictEqual(stats.unsourcedTagBoundaries, 1);
    assert.ok(stats.uncitedTailChars > 0);
    assert.deepStrictEqual(stats.citationTypes, { news: 1, journal: 2, book: 1, url: 1, web: 1 });
  });
});

describe('real Enterprise records (optional fixture)', () => {
  const fixture = path.join(__dirname, 'fixtures', 'enterprise-sample.ndjson');
  test('every embedded span has an online citation, every unembedded span a citation and a reason, text is clean', { skip: !fs.existsSync(fixture) && 'no enterprise-sample.ndjson yet (run scripts/sample-article-structure.js)' }, () => {
    const records = fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let total = 0;
    for (const record of records) {
      const { spans, unembedded } = extractSpans(record, { includeListItems: true, includeTableRows: true });
      total += spans.length;
      for (const s of spans) assert.ok(s.citations.some(isOnlineCitation), `${record.name}: embedded span without an online citation`);
      for (const s of unembedded) {
        assert.ok(s.citations.length >= 1, `${record.name}: unembedded span without any citation`);
        assert.ok(['no_online_citation', 'short'].includes(s.reason), `${record.name}: reason ${s.reason}`);
        assert.ok(s.citations.every((c) => isOnlineCitation(c) || typeof c.text === 'string'), `${record.name}: offline citation without text`);
      }
      for (const s of [...spans, ...unembedded]) {
        assert.ok(!/\[\d+\]|\[edit\]|<\/?[a-z]|\{\{|\|\}|mw-parser-output/.test(s.text), `${record.name}: markup in "${s.text.slice(0, 80)}"`);
        for (const c of s.citations) assert.ok(!/mw-parser-output|\{\{/.test(c.text ?? ''), `${record.name}: CSS/markup in citation text`);
      }
      const byUnit = new Map();
      for (const s of [...spans, ...unembedded]) byUnit.set(`${s.kind}:${s.unitIndex}`, [...(byUnit.get(`${s.kind}:${s.unitIndex}`) ?? []), s.spanIndex]);
      for (const [unit, indices] of byUnit) assert.deepStrictEqual([...indices].sort((a, b) => a - b), indices.map((_, i) => i), `${record.name} ${unit}`);
    }
    assert.ok(total > 0, 'expected at least one span across the sampled records');
  });
});

describe('malformed percent-escapes in links (seen in real articles)', () => {
  const bad = `<html><body><section data-mw-section-id="0">
<p>This paragraph has a citation whose marker link carries a broken percent escape in it.<sup class="mw-ref reference" typeof="mw:Extension/ref"><a href="./X#cite_note-%E0%A4%A"><span class="mw-reflink-text">[1]</span></a></sup> And this sentence is cited by a short footnote whose link is broken too.<sup class="mw-ref reference" typeof="mw:Extension/ref"><a href="./X#cite_note-sfn-2"><span class="mw-reflink-text">[2]</span></a></sup></p>
</section><section data-mw-section-id="1"><h2>References</h2><ol class="mw-references references">
<li id="cite_note-%E0%A4%A"><span class="mw-reference-text reference-text"><a rel="mw:ExtLink" class="external free" href="https://example.org/a">https://example.org/a</a></span></li>
<li id="cite_note-sfn-2"><span class="mw-reference-text reference-text"><a href="#CITEREF%ZZbroken">Someone 1999</a>, p. 3.</span></li>
</ol></section></body></html>`;

  test('extraction does not throw and still keeps what it can', () => {
    const { spans, unembedded } = extractSpans(bad, { includeListItems: true, includeTableRows: true });
    assert.deepStrictEqual(spans.map((s) => s.citations[0].url), ['https://example.org/a']);
    assert.strictEqual(unembedded.length, 1); // the footnote's target can't be resolved: stored as an offline citation
    assert.strictEqual(unembedded[0].citations[0].url, null);
  });
});
