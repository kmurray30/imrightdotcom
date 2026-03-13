/**
 * Parser unit tests for article_extractor.
 * Uses 5g-cancer-conspiracy.yaml fixture (copy of wiki_searcher wikis-fetched).
 *
 * Run: node --test __tests__/parser.test.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import yaml from 'yaml';
import {
  parseRefs,
  findAllRefs,
  splitSections,
  parseCiteTemplate,
} from '../parser/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', '5g-cancer-conspiracy.yaml');

const WHITELIST_TYPES = new Set([
  'web',
  'news',
  'journal',
  'magazine',
  'report',
  'dictionary',
  'encyclopedia',
]);

function loadFixture() {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  return yaml.parse(raw);
}

describe('parseRefs', () => {
  test('parses all pages and extracts citations with expected count', () => {
    const fixture = loadFixture();
    const pages = fixture.pages ?? [];
    assert.ok(pages.length > 0, 'fixture should have pages');

    let totalCitations = 0;
    for (const page of pages) {
      const source = page.source ?? '';
      const title = page.title ?? 'Unknown';
      const citations = parseRefs(source, title, 1, WHITELIST_TYPES);
      totalCitations += citations.length;
    }

    // Baseline: citations with whitelist (includes resolved self-closing named refs)
    assert.strictEqual(totalCitations, 2358);
  });

  test('whitelisted types (web, news, journal) are extracted; non-whitelisted skipped', () => {
    const fixture = loadFixture();
    const allCitations = [];
    for (const page of fixture.pages ?? []) {
      const citations = parseRefs(
        page.source ?? '',
        page.title ?? 'Unknown',
        1,
        WHITELIST_TYPES
      );
      allCitations.push(...citations);
    }

    const types = new Set(allCitations.map((citation) => citation.type));
    assert.ok(types.has('web'), 'should extract web citations');
    assert.ok(types.has('news'), 'should extract news citations');
    assert.ok(types.has('journal'), 'should extract journal citations');
    assert.ok(!types.has('book'), 'should not include book (non-whitelisted)');
  });

  test('sentence does not contain cite template content when period is inside preceding ref', () => {
    // When a sentence boundary (e.g. "Report. ") falls inside a ref, we must not use it,
    // or we'd extract from mid-ref and get orphaned template params (|url=, |publisher=) in the sentence.
    // No period before the first ref so the first boundary found is "Report. " inside the ref.
    const source = `
      Some text without period<ref>{{cite web|title=Report. |publisher=BBC|url=https://example.com}}</ref> collapse
      <ref>{{cite web|url=https://example.com|title=Target}}</ref> or that a global elite.
    `;
    const citations = parseRefs(source, 'Test', 1, WHITELIST_TYPES);
    assert.ok(citations.length >= 1, 'should extract at least one citation');
    for (const citation of citations) {
      assert.ok(!citation.sentence.includes('|url='), `sentence should not contain |url=: ${citation.sentence.slice(0, 80)}...`);
      assert.ok(!citation.sentence.includes('|publisher='), `sentence should not contain |publisher=: ${citation.sentence.slice(0, 80)}...`);
      assert.ok(!citation.sentence.includes('}}'), `sentence should not contain }}: ${citation.sentence.slice(0, 80)}...`);
    }
  });

  test('refs without url are excluded', () => {
    // Plain-text ref "Izvestia, 8 February 1991, pg. 7" has no cite template, no URL
    const sourceWithPlainRef = `
      Some text about Flight 007.<ref>Izvestia, 8 February 1991, pg. 7</ref>
      More text.<ref>{{cite web|url=https://example.com|title=Test}}</ref>
    `;
    const citations = parseRefs(sourceWithPlainRef, 'Test', 1, WHITELIST_TYPES);
    assert.strictEqual(citations.length, 1);
    assert.strictEqual(citations[0].link, 'https://example.com');
  });
});

describe('named ref resolution', () => {
  test('<ref name="X"/> gets content from first definition', () => {
    const source = `
      Intro text.<ref name="Blount">{{cite book|last=Blount|first=Brian K.|url=https://books.google.com/books?id=ate5WYoD_jgC|title=Revelation|year=2009}}</ref>
      More text.<ref name="Blount"/>
    `;
    const refs = findAllRefs(source);
    assert.strictEqual(refs.length, 2);

    const withContent = refs.filter((ref) => ref.content && ref.content.includes('cite book'));
    assert.strictEqual(withContent.length, 2);

    const firstContent = withContent[0].content;
    const secondContent = withContent[1].content;
    assert.strictEqual(secondContent, firstContent);
  });
});

describe('parseCiteTemplate', () => {
  test('returns null when url is missing', () => {
    const result = parseCiteTemplate('{{cite book|title=Foo|year=2009}}');
    assert.strictEqual(result, null);
  });

  test('returns null when url does not start with http', () => {
    const result = parseCiteTemplate(
      '{{cite web|url=ftp://example.com|title=Test}}'
    );
    assert.strictEqual(result, null);
  });

  test('extracts type, url, blurb from valid cite web', () => {
    const result = parseCiteTemplate(
      '{{cite web|url=https://example.com|title=Test Title}}'
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.type, 'web');
    assert.strictEqual(result.url, 'https://example.com');
    assert.strictEqual(result.blurb, 'Test Title');
  });

  test('handles case and space variance in template', () => {
    const result = parseCiteTemplate(
      '{{Cite  web | url = https://example.com | title = Foo }}'
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.type, 'web');
    assert.strictEqual(result.url, 'https://example.com');
  });
});

describe('splitSections', () => {
  test('splits by == Header == and assigns Introduction to content before first header', () => {
    const source = `
      Intro paragraph.

      == First Section ==
      Section content.

      == Second Section ==
      More content.
    `;
    const sections = splitSections(source);
    assert.strictEqual(sections.length, 3);
    assert.strictEqual(sections[0].name, 'Introduction');
    assert.ok(sections[0].content.includes('Intro paragraph'));
    assert.strictEqual(sections[1].name, 'First Section');
    assert.strictEqual(sections[2].name, 'Second Section');
  });
});
