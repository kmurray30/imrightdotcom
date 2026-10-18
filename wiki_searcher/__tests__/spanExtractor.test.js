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
import { analyzeArticleHtml, extractCitedSpans } from '../spanExtractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'parsoid-sample.html'), 'utf8');

const byText = (spans, needle) => spans.find((s) => s.text.includes(needle));

describe('extractCitedSpans — paragraphs (default options)', () => {
  const spans = extractCitedSpans({ name: 'Test Article', article_body: { html } });

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

  test('refs without an http link ({{sfn}}-style) yield no span', () => {
    assert.ok(!spans.some((s) => s.text.includes('shortened footnote')));
  });

  test('{{citation needed}} is a boundary: the tagged claim is dropped', () => {
    assert.ok(!spans.some((s) => s.text.includes('unsourced and tagged')));
  });

  test('a note marker does not count; a paywalled-only span is dropped', () => {
    assert.ok(!spans.some((s) => s.text.includes('paywalled source only')));
    assert.ok(!spans.some((s) => s.citations.some((c) => c.url.includes('jstor.org'))));
  });

  test('other inline tags ([when?]) vanish from the text without splitting the span', () => {
    const span = byText(spans, 'properly cited closing sentence');
    assert.strictEqual(span.text, 'Finally a properly cited closing sentence rounds out the paragraph with enough words.');
    assert.deepStrictEqual(span.citations.map((c) => c.url), ['https://example.com/eight']);
    assert.strictEqual(span.citations[0].publisher, 'Example');
  });

  test('too-short spans are dropped', () => {
    assert.ok(!spans.some((s) => s.text === 'Short.'));
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
      ['paragraph', 2, 0],
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
    assert.strictEqual(on.stats.spansDroppedShort >= 1, true); // "Best Picture, 1999"
  });

  test('table rows become "Header: value" spans with the row\'s citations', () => {
    const { spans, stats } = analyzeArticleHtml(html, { includeTableRows: true });
    const rows = spans.filter((s) => s.kind === 'table_row');
    assert.deepStrictEqual(rows.map((s) => s.text), ['Year: 2001; Title: Alpha; Notes: Won the big prize that year']);
    assert.deepStrictEqual(rows[0].citations.map((c) => c.type), ['book']);
    assert.strictEqual(stats.units.table_row, 2); // header row excluded; infobox/navbox rows excluded
  });

  test('stats reflect the fixture', () => {
    const { stats } = analyzeArticleHtml(html);
    assert.strictEqual(stats.units.paragraph, 4);
    assert.strictEqual(stats.citedUnits.paragraph, 4);
    assert.strictEqual(stats.references, 9);
    assert.strictEqual(stats.referencesWithoutUrl, 3); // note, sfn, paywall-excluded
    assert.strictEqual(stats.noteMarkers, 1);
    assert.strictEqual(stats.stackedGroups, 1);
    assert.strictEqual(stats.unsourcedTagBoundaries, 1);
    assert.ok(stats.uncitedTailChars > 0);
    assert.deepStrictEqual(stats.citationTypes, { news: 1, journal: 2, book: 1, url: 1, web: 1 });
  });
});

describe('real Enterprise records (optional fixture)', () => {
  const fixture = path.join(__dirname, 'fixtures', 'enterprise-sample.ndjson');
  test('every span of every record has an http citation and clean text', { skip: !fs.existsSync(fixture) && 'no enterprise-sample.ndjson yet (run scripts/sample-article-structure.js)' }, () => {
    const records = fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let total = 0;
    for (const record of records) {
      const spans = extractCitedSpans(record);
      total += spans.length;
      for (const s of spans) {
        assert.ok(s.citations.length >= 1 && s.citations.every((c) => /^https?:\/\//.test(c.url)), `${record.name}: span without http citation`);
        assert.ok(!/\[\d+\]|\[edit\]|<\/?[a-z]|\{\{|\|\}/.test(s.text), `${record.name}: markup in "${s.text.slice(0, 80)}"`);
      }
    }
    assert.ok(total > 0, 'expected at least one span across the sampled records');
  });
});
