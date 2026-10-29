/**
 * Span-search candidates (fromSpans.js) and extract() fed with span matches.
 *
 * Run: node --test __tests__/fromSpans.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { citationsFromSpans } from '../fromSpans.js';
import { extract } from '../index.js';

const options = { citationTypes: new Set(['web', 'news']), excludeUrlPatterns: ['jstor.org'] };

const span = (title, text, citations) => ({ title, section: 'History', kind: 'paragraph', text, citations, score: 0.8 });

describe('citationsFromSpans', () => {
  test("maps each kept citation to a candidate: every span's first citation, then the others", () => {
    const spans = [
      span('Eiffel Tower', 'The tower was finished in 1889.', [
        { type: 'web', url: 'https://example.org/a', archive_url: 'https://web.archive.org/a', title: 'Tower history' },
        { type: 'news', url: 'https://news.example.com/b', archive_url: null, title: null, publisher: 'The Times', date: '1889-03-31' },
      ]),
      span('Paris', 'Paris is the capital.', [{ type: 'web', url: 'https://example.org/c', title: 'Capital' }]),
    ];
    assert.deepStrictEqual(citationsFromSpans(spans, options), [
      { link: 'https://example.org/a', archiveLink: 'https://web.archive.org/a', title: 'Tower history', content: 'The tower was finished in 1889.', article_title: 'Eiffel Tower' },
      { link: 'https://example.org/c', archiveLink: null, title: 'Capital', content: 'Paris is the capital.', article_title: 'Paris' },
      { link: 'https://news.example.com/b', archiveLink: null, title: 'The Times - 1889-03-31', content: 'The tower was finished in 1889.', article_title: 'Eiffel Tower' },
    ]);
  });

  test('drops citations without a URL, of other types, or matching an excluded pattern', () => {
    const spans = [
      span('A', 'Text.', [
        { type: 'book', url: 'https://books.example.com/x', title: 'A book' },
        { type: 'footnote', url: null, text: 'Smith 2001, p. 4' },
        { type: 'web', url: 'https://www.JSTOR.org/stable/1', title: 'Paywalled' },
        { type: 'Web', url: 'https://ok.example.com', title: 'Kept' },
      ]),
    ];
    assert.deepStrictEqual(
      citationsFromSpans(spans, options).map((c) => c.link),
      ['https://ok.example.com']
    );
  });
});

describe('extract() with span matches', () => {
  test('uses the spans for each query and its argument, deduping across terms', async () => {
    const conspiracy = { topic: 't', angles: [{ argument: 'the tower is old', search_queries: ['eiffel tower age'] }] };
    const shared = { type: 'web', url: 'https://example.org/shared', title: 'Shared' };
    const wikiFiltered = {
      search_queries: ['eiffel tower age'],
      search_query_article_titles: { 'eiffel tower age': ['Eiffel Tower'] },
      pages: [],
      span_matches: {
        'eiffel tower age': [span('Eiffel Tower', 'Finished in 1889.', [shared, { type: 'web', url: 'https://example.org/q', title: 'Q' }])],
        'the tower is old': [span('Eiffel Tower', 'Finished in 1889.', [shared, { type: 'news', url: 'https://example.org/arg', title: 'Arg' }])],
      },
    };
    const { extracted, stats } = await extract(conspiracy, wikiFiltered, { check_links: false });
    assert.deepStrictEqual(Object.keys(extracted), ['eiffel tower age', 'the tower is old']);
    assert.deepStrictEqual(extracted['eiffel tower age'].map((c) => c.link), ['https://example.org/shared', 'https://example.org/q']);
    assert.deepStrictEqual(extracted['the tower is old'].map((c) => c.link), ['https://example.org/arg']);
    assert.strictEqual(extracted['the tower is old'][0].content, 'Finished in 1889.');
    assert.strictEqual(stats.extractedCount, 3);
  });
});
