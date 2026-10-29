#!/usr/bin/env node
/**
 * Measures what the cited-span index would contain, on a random sample of
 * REAL snapshot articles, before the rebuild is run: how much cited content
 * sits in paragraphs vs list items vs table rows, span sizes, what the
 * length floor drops, articles with no usable citation, reference types, and
 * whether Enterprise's Structured Contents payload carries citation
 * positions (which would let it replace HTML parsing).
 *
 * Pulls ONE random chunk of the same Snapshot the build uses (free; identical
 * records), extracts it, reservoir-samples N articles, and runs
 * wiki_searcher/spanExtractor.js on each with lists and tables enabled so the
 * report can break them out. Also writes a few raw records to
 * wiki_searcher/__tests__/fixtures/enterprise-sample.ndjson for unit tests.
 *
 * Usage: node wiki_searcher/scripts/sample-article-structure.js
 *          [--articles 500] [--chunk random|<index>] [--dest ./wiki-snapshots-v2]
 *          [--fixtures 10] [--fixtures-to-db 0] [--no-structured] [--ndjson <already-extracted chunk file>]
 *   --fixtures N        write N raw records to __tests__/fixtures/enterprise-sample.ndjson (when run in the repo)
 *   --fixtures-to-db N  store N raw records in Postgres table wiki_sample_fixtures instead (when run on
 *                       Railway, where the repo isn't writable; pull them later with scripts/pull-sample-fixtures.js)
 *   Needs WIKIMEDIA_USERNAME / WIKIMEDIA_PASSWORD (see utils/wikimediaAuth.js); DATABASE_URL for --fixtures-to-db.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { loadEnv } from '../../imright/load-env.js';
import { getAccessToken } from '../../utils/wikimediaAuth.js';
import { analyzeArticleHtml, MIN_SPAN_WORDS, MIN_SPAN_CHARS } from '../spanExtractor.js';

loadEnv();
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = 'https://api.enterprise.wikimedia.com';
const IDENTIFIER = 'enwiki_namespace_0';
const FIXTURE_PATH = path.join(__dirname, '..', '__tests__', 'fixtures', 'enterprise-sample.ndjson');

function parseArgs(argv) {
  const options = { articles: 500, chunk: 'random', dest: './wiki-snapshots-v2', fixtures: 10, fixturesToDb: 0, structured: true, ndjson: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--articles') options.articles = Number(argv[++i]);
    else if (a === '--chunk') options.chunk = argv[++i];
    else if (a === '--dest') options.dest = argv[++i];
    else if (a === '--fixtures') options.fixtures = Number(argv[++i]);
    else if (a === '--fixtures-to-db') options.fixturesToDb = Number(argv[++i]);
    else if (a === '--no-structured') options.structured = false;
    else if (a === '--ndjson') options.ndjson = argv[++i];
  }
  return options;
}
const options = parseArgs(process.argv.slice(2));

const authHeaders = async () => ({ Authorization: `Bearer ${await getAccessToken()}` });
const fmtMB = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '-');

async function pickAndDownloadChunk() {
  fs.mkdirSync(options.dest, { recursive: true });
  const infoResponse = await fetch(`${API_BASE}/v2/snapshots/${IDENTIFIER}`, { method: 'POST', headers: await authHeaders() });
  if (!infoResponse.ok) throw new Error(`Snapshot lookup failed: ${infoResponse.status} ${infoResponse.statusText}`);
  const info = await infoResponse.json();
  const chunkIds = info.chunks ?? [];
  if (!chunkIds.length) throw new Error('Snapshot has no chunks.');
  const index = options.chunk === 'random' ? Math.floor(Math.random() * chunkIds.length) : Number(options.chunk);
  const chunkId = chunkIds[index];
  console.log(`Snapshot ${IDENTIFIER}: ${chunkIds.length} chunks, ${info.record_count?.toLocaleString() ?? '?'} articles. Using chunk #${index} (${chunkId}).`);

  const ndjsonPath = path.join(options.dest, `${chunkId}.ndjson`);
  if (fs.existsSync(ndjsonPath)) {
    console.log(`Already extracted: ${ndjsonPath}`);
    return ndjsonPath;
  }
  const archivePath = path.join(options.dest, `${chunkId}.tar.gz`);
  const response = await fetch(`${API_BASE}/v2/snapshots/${IDENTIFIER}/chunks/${chunkId}/download`, { headers: await authHeaders() });
  if (!response.ok) throw new Error(`Chunk download failed: ${response.status} ${response.statusText}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  let lastPrint = 0;
  const out = fs.createWriteStream(archivePath);
  for await (const piece of Readable.fromWeb(response.body)) {
    received += piece.length;
    if (!out.write(piece)) await new Promise((resolve) => out.once('drain', resolve));
    if (Date.now() - lastPrint > 1000) {
      lastPrint = Date.now();
      process.stdout.write(`\r  downloading ${fmtMB(received)}${total ? ` / ${fmtMB(total)}` : ''}`);
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  process.stdout.write(`\r  downloaded ${fmtMB(received)}                    \n`);

  const { stdout } = await execFileAsync('tar', ['tzf', path.basename(archivePath)], { cwd: options.dest, maxBuffer: 10 * 1024 * 1024 });
  const entry = stdout.split('\n').map((l) => l.trim().replace(/^\.\//, '')).find((l) => l.endsWith('.ndjson'));
  if (!entry) throw new Error('No .ndjson inside the chunk archive.');
  await execFileAsync('tar', ['xzf', path.basename(archivePath)], { cwd: options.dest });
  fs.rmSync(archivePath, { force: true });
  const extracted = path.join(options.dest, entry);
  if (extracted !== ndjsonPath) fs.renameSync(extracted, ndjsonPath);
  console.log(`Extracted to ${ndjsonPath} (${fmtMB(fs.statSync(ndjsonPath).size)}; kept for re-runs with --ndjson).`);
  return ndjsonPath;
}

/** Reservoir sample of N raw lines, without holding the whole chunk in memory. */
async function sampleLines(ndjsonPath, n) {
  const reservoir = [];
  let seen = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    seen++;
    if (reservoir.length < n) reservoir.push(line);
    else {
      const j = Math.floor(Math.random() * seen);
      if (j < n) reservoir[j] = line;
    }
    if (seen % 5000 === 0) process.stdout.write(`\r  scanned ${seen.toLocaleString()} articles`);
  }
  process.stdout.write(`\r  scanned ${seen.toLocaleString()} articles; sampled ${reservoir.length}\n`);
  return { lines: reservoir, total: seen };
}

const bucket = (value, edges) => {
  for (const edge of edges) if (value < edge) return `<${edge}`;
  return `≥${edges[edges.length - 1]}`;
};
const sentenceCount = (text) => (text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text]).filter((s) => s.trim()).length;
const addTo = (obj, key, n = 1) => { obj[key] = (obj[key] ?? 0) + n; };
const sumKinds = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);

function printTable(title, rows) {
  console.log(`\n${title}`);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const row of rows) console.log('  ' + row.map((cell, i) => String(cell).padEnd(widths[i])).join('  '));
}

function report(records, totalInChunk) {
  const agg = {
    articles: records.length, withHtml: 0, withWikitext: 0, htmlBytes: 0, wikitextBytes: 0,
    units: { paragraph: 0, list_item: 0, table_row: 0 }, citedUnits: { paragraph: 0, list_item: 0, table_row: 0 },
    unitChars: { paragraph: 0, list_item: 0, table_row: 0 }, spansKept: { paragraph: 0, list_item: 0, table_row: 0 },
    spanChars: { paragraph: 0, list_item: 0, table_row: 0 }, unembeddedShort: 0, unembeddedNoOnline: 0, droppedNoCitation: 0, uncitedTailChars: 0,
    charsUnembeddedShort: 0, charsUnembeddedNoOnline: 0, charsDroppedNoCitation: 0, linklessByReason: {}, linklessExamples: [],
    unsourcedTags: 0, markers: 0, noteMarkers: 0, stacked: 0, references: 0, referencesWithoutUrl: 0, citationTypes: {},
    spanLen: {}, spanSentences: {}, endsAtSentence: 0, totalSpans: 0, articlesNoSpans: 0, articlesNoMarkers: 0, articlesNoHtml: 0,
    citationsPerSpan: {}, exampleParagraphSpans: [], exampleListItems: [], exampleRows: [],
  };
  for (const record of records) {
    const html = record.article_body?.html;
    const wikitext = record.article_body?.wikitext;
    if (wikitext) { agg.withWikitext++; agg.wikitextBytes += Buffer.byteLength(wikitext); }
    if (!html) { agg.articlesNoHtml++; continue; }
    agg.withHtml++; agg.htmlBytes += Buffer.byteLength(html);
    const { spans, stats } = analyzeArticleHtml(html, { includeListItems: true, includeTableRows: true, diagnostics: true });
    for (const kind of Object.keys(agg.units)) {
      agg.units[kind] += stats.units[kind]; agg.citedUnits[kind] += stats.citedUnits[kind]; agg.unitChars[kind] += stats.unitChars[kind];
      agg.spansKept[kind] += stats.spansKept[kind]; agg.spanChars[kind] += stats.spanChars[kind];
    }
    agg.unembeddedShort += stats.spansUnembeddedShort; agg.unembeddedNoOnline += stats.spansUnembeddedNoOnlineCitation; agg.droppedNoCitation += stats.spansDroppedNoCitation;
    agg.uncitedTailChars += stats.uncitedTailChars; agg.charsUnembeddedShort += stats.charsUnembeddedShort; agg.charsUnembeddedNoOnline += stats.charsUnembeddedNoOnlineCitation; agg.charsDroppedNoCitation += stats.charsDroppedNoCitation;
    for (const [reason, n] of Object.entries(stats.referencesWithoutUrlByReason)) addTo(agg.linklessByReason, reason, n);
    for (const example of stats.linklessExamples) if (agg.linklessExamples.length < 12) agg.linklessExamples.push(`${record.name}: ${example}`);
    agg.unsourcedTags += stats.unsourcedTagBoundaries; agg.markers += stats.markers; agg.noteMarkers += stats.noteMarkers; agg.stacked += stats.stackedGroups;
    agg.references += stats.references; agg.referencesWithoutUrl += stats.referencesWithoutUrl;
    for (const [type, n] of Object.entries(stats.citationTypes)) addTo(agg.citationTypes, type, n);
    if (stats.markers === 0) agg.articlesNoMarkers++;
    if (spans.length === 0) agg.articlesNoSpans++;
    for (const s of spans) {
      agg.totalSpans++;
      addTo(agg.spanLen, bucket(s.text.length, [100, 200, 400, 800, 1600]));
      addTo(agg.spanSentences, bucket(sentenceCount(s.text), [2, 3, 5]));
      addTo(agg.citationsPerSpan, bucket(s.citations.length, [2, 3, 5]));
      if (/[.!?]["')\]]*$/.test(s.text)) agg.endsAtSentence++;
      const example = `${record.name} › ${s.section}: "${s.text.slice(0, 140)}${s.text.length > 140 ? '…' : ''}" → ${s.citations.map((c) => `${c.type}: ${c.url}`).join(' | ')}`;
      if (s.kind === 'paragraph' && agg.exampleParagraphSpans.length < 6 && Math.random() < 0.02) agg.exampleParagraphSpans.push(example);
      if (s.kind === 'list_item' && agg.exampleListItems.length < 8) agg.exampleListItems.push(example);
      if (s.kind === 'table_row' && agg.exampleRows.length < 6) agg.exampleRows.push(example);
    }
  }

  const scale = 7_340_000 / agg.withHtml; // ≈ articles in the snapshot, for whole-corpus projections
  console.log(`\n================ SAMPLE OF ${agg.articles} ARTICLES (chunk holds ${totalInChunk.toLocaleString()}) ================`);
  console.log(`Records with article_body.html: ${agg.withHtml}/${agg.articles}   with wikitext: ${agg.withWikitext}/${agg.articles}`);
  console.log(`Average size per article: html ${fmtMB(agg.htmlBytes / Math.max(1, agg.withHtml)).replace(' MB', '')} MB vs wikitext ${(agg.wikitextBytes / Math.max(1, agg.withWikitext) / 1e6).toFixed(2)} MB (html is ${(agg.htmlBytes / Math.max(1, agg.wikitextBytes)).toFixed(1)}× larger)`);

  const totalKeptChars = sumKinds(agg.spanChars);
  printTable('Where cited content lives (the lists/tables decision):', [
    ['kind', 'units', 'cited units', 'spans kept', 'span chars', 'share of kept chars', 'projected spans (all enwiki)'],
    ...['paragraph', 'list_item', 'table_row'].map((kind) => [
      kind, agg.units[kind].toLocaleString(), `${agg.citedUnits[kind].toLocaleString()} (${pct(agg.citedUnits[kind], agg.units[kind])})`,
      agg.spansKept[kind].toLocaleString(), fmtMB(agg.spanChars[kind]), pct(agg.spanChars[kind], totalKeptChars), Math.round(agg.spansKept[kind] * scale).toLocaleString(),
    ]),
  ]);

  const unembeddedChars = agg.charsUnembeddedShort + agg.charsUnembeddedNoOnline;
  const unembedded = agg.unembeddedShort + agg.unembeddedNoOnline;
  const notKeptChars = agg.uncitedTailChars + agg.charsDroppedNoCitation + unembeddedChars;
  printTable('Spans:', [
    ['metric', 'value'],
    ['embedded', agg.totalSpans.toLocaleString()],
    ['stored unembedded: no online citation (books w/o url, sfn, plain text, excluded hosts)', `${agg.unembeddedNoOnline.toLocaleString()} (${pct(agg.unembeddedNoOnline, agg.totalSpans + unembedded)} of cited spans)`],
    [`stored unembedded: under ${MIN_SPAN_WORDS} words / ${MIN_SPAN_CHARS} chars`, `${agg.unembeddedShort.toLocaleString()} (${pct(agg.unembeddedShort, agg.totalSpans + unembedded)} of cited spans)`],
    ['dropped: markers whose reference entries describe nothing', agg.droppedNoCitation.toLocaleString()],
    ['text in cited units NOT embedded', `${pct(notKeptChars, notKeptChars + totalKeptChars)} of cited-unit text, of which:`],
    ['    stored unembedded: no online citation', pct(agg.charsUnembeddedNoOnline, notKeptChars)],
    [`    stored unembedded: under ${MIN_SPAN_WORDS} words / ${MIN_SPAN_CHARS} chars`, pct(agg.charsUnembeddedShort, notKeptChars)],
    ['    uncited tails after the last citation, {{cn}}-tagged claims (not stored)', pct(agg.uncitedTailChars, notKeptChars)],
    ['{{citation needed}} boundaries', agg.unsourcedTags.toLocaleString()],
    ['stacked citation groups', `${agg.stacked.toLocaleString()} (${pct(agg.stacked, agg.totalSpans)} of spans)`],
    ['spans ending at sentence punctuation', pct(agg.endsAtSentence, agg.totalSpans)],
    ['avg span chars', Math.round(totalKeptChars / Math.max(1, agg.totalSpans))],
    ['span length (chars)', JSON.stringify(agg.spanLen)],
    ['sentences per span', JSON.stringify(agg.spanSentences)],
    ['citations per span', JSON.stringify(agg.citationsPerSpan)],
  ]);

  printTable('References and markers:', [
    ['metric', 'value'],
    ['reference-list entries', agg.references.toLocaleString()],
    ['entries with no online citation', `${agg.referencesWithoutUrl.toLocaleString()} (${pct(agg.referencesWithoutUrl, agg.references)})`],
    ['    by reason', Object.entries(agg.linklessByReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}: ${n}`).join(' | ')],
    ['inline markers', agg.markers.toLocaleString()],
    ['of which notes', `${agg.noteMarkers.toLocaleString()} (${pct(agg.noteMarkers, agg.markers)})`],
    ['citation types (kept spans)', Object.entries(agg.citationTypes).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ')],
  ]);

  printTable('Coverage:', [
    ['metric', 'value'],
    ['articles with no citation markers at all', `${agg.articlesNoMarkers} (${pct(agg.articlesNoMarkers, agg.withHtml)})`],
    ['articles with zero kept spans', `${agg.articlesNoSpans} (${pct(agg.articlesNoSpans, agg.withHtml)})`],
    ['articles without article_body.html', agg.articlesNoHtml],
    ['projected kept spans, all of enwiki', Math.round(agg.totalSpans * scale).toLocaleString()],
    ['projected span text, all of enwiki', `${(totalKeptChars * scale / 1e9).toFixed(1)} GB`],
    ['projected unembedded spans, all of enwiki', Math.round(unembedded * scale).toLocaleString()],
    ['projected unembedded span text, all of enwiki', `${(unembeddedChars * scale / 1e9).toFixed(1)} GB`],
  ]);

  const examples = (title, list) => { console.log(`\n${title}`); if (!list.length) console.log('  (none)'); for (const e of list) console.log(`  - ${e}`); };
  examples('Random paragraph spans:', agg.exampleParagraphSpans);
  examples('Cited list items (as spans):', agg.exampleListItems);
  examples('Cited table rows (as spans):', agg.exampleRows);
  examples('Reference entries with no usable link (first few per article):', agg.linklessExamples);
}

/** N records with HTML, spread across sizes (small to ~600 KB), so the fixtures cover stubs and long articles alike. */
function chooseFixtureRecords(records, n) {
  const candidates = records
    .filter((r) => r.article_body?.html && Buffer.byteLength(r.article_body.html) < 600_000)
    .sort((a, b) => Buffer.byteLength(a.article_body.html) - Buffer.byteLength(b.article_body.html));
  const step = Math.max(1, Math.floor(candidates.length / Math.max(1, n)));
  return candidates.filter((_, i) => i % step === 0).slice(0, n);
}

function writeFixtures(records, n) {
  const chosen = chooseFixtureRecords(records, n);
  if (!chosen.length) return;
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, chosen.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nWrote ${chosen.length} raw records (${fmtMB(fs.statSync(FIXTURE_PATH).size)}) to ${path.relative(process.cwd(), FIXTURE_PATH)} — commit it so the unit tests cover real articles.`);
}

/** Same records, but into Postgres (for a run on Railway); scripts/pull-sample-fixtures.js turns them into the fixture file. */
async function storeFixturesInDb(records, n) {
  const chosen = chooseFixtureRecords(records, n);
  if (!chosen.length) return;
  const { getPool } = await import('../../imright/scripts/db.js');
  const pool = getPool();
  if (!pool) {
    console.log('\n--fixtures-to-db: DATABASE_URL is not set; skipping.');
    return;
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS wiki_sample_fixtures (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, page_id BIGINT, html_bytes INT, record JSONB NOT NULL, sampled_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query('TRUNCATE wiki_sample_fixtures');
  for (const r of chosen) {
    await pool.query('INSERT INTO wiki_sample_fixtures (name, page_id, html_bytes, record) VALUES ($1, $2, $3, $4::jsonb)', [
      r.name, r.identifier ?? null, Buffer.byteLength(r.article_body.html), JSON.stringify(r),
    ]);
  }
  await pool.end();
  console.log(`\nStored ${chosen.length} raw records in Postgres table wiki_sample_fixtures — run node wiki_searcher/scripts/pull-sample-fixtures.js (through the tunnel) to turn them into the unit-test fixture file.`);
}

/**
 * Raw markup of the things the extractor's selectors depend on, from one real
 * record, so a mismatch between Parsoid's spec and what Enterprise actually
 * ships (e.g. data-mw stripped) shows up in this report rather than as silent
 * zero counts.
 */
function markupCheck(records) {
  console.log('\n================ MARKUP CHECK (first record with citations) ================');
  const record = records.find((r) => r.article_body?.html && /cite_note/.test(r.article_body.html));
  if (!record) {
    console.log('  no sampled record contains "cite_note" — citation markup is not what the extractor expects!');
    return;
  }
  const $ = cheerio.load(record.article_body.html);
  const count = (selector) => $(selector).length;
  console.log(`  article: ${record.name}`);
  console.log(`  counts: sup.mw-ref=${count('sup.mw-ref')} sup.reference=${count('sup.reference')} span.mw-ref=${count('span.mw-ref')} [typeof~=mw:Extension/ref]=${count('[typeof~="mw:Extension/ref"]')} ` +
    `li[id^=cite_note]=${count('li[id^="cite_note"]')} cite.citation=${count('cite.citation')} [data-mw]=${count('[data-mw]')} section[data-mw-section-id]=${count('section[data-mw-section-id]')} ` +
    `p=${count('p')} table.infobox=${count('table.infobox')} figure=${count('figure')} .hatnote=${count('.hatnote')} sup.Inline-Template=${count('sup.Inline-Template')}`);
  const show = (label, selector, max) => {
    const el = $(selector).first();
    console.log(`  ${label}: ${el.length ? $.html(el).replace(/\s+/g, ' ').slice(0, max) : '(none)'}`);
  };
  show('first citation marker', 'sup.mw-ref, sup.reference, span.mw-ref, [typeof~="mw:Extension/ref"]', 700);
  show('first reference-list entry', 'li[id^="cite_note"]', 1400);
  show('first paragraph with a marker', 'p:has(sup.mw-ref), p:has(sup.reference), p:has([typeof~="mw:Extension/ref"])', 900);
  show('first inline template (if any)', 'sup.Inline-Template', 500);
}

/** Does Enterprise's Structured Contents payload place citations within paragraph text? Prints the raw shape so we can tell. */
async function probeStructuredContents(records) {
  console.log('\n================ STRUCTURED CONTENTS PROBE ================');
  const titles = records.filter((r) => r.name && r.article_body?.html && /cite_note/.test(r.article_body.html)).slice(0, 5).map((r) => r.name);
  for (const title of titles) {
    try {
      const response = await fetch(`${API_BASE}/v2/structured-contents/${encodeURIComponent(title.replace(/ /g, '_'))}`, {
        method: 'POST',
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: [{ field: 'is_part_of.identifier', value: 'enwiki' }], limit: 1 }),
      });
      if (!response.ok) {
        console.log(`  ${title}: HTTP ${response.status} — ${(await response.text()).slice(0, 200)}`);
        if (response.status === 401 || response.status === 403 || response.status === 404) break;
        continue;
      }
      const [doc] = await response.json();
      if (!doc) { console.log(`  ${title}: empty result`); continue; }
      console.log(`  ${title}: top-level keys: ${Object.keys(doc).join(', ')}`);
      let paragraph = null;
      const walk = (parts) => { for (const part of parts ?? []) { if (part?.type === 'paragraph' && part.citations?.length && !paragraph) paragraph = part; walk(part?.has_parts); } };
      walk(doc.sections);
      if (paragraph) {
        console.log(`  first paragraph with citations (keys: ${Object.keys(paragraph).join(', ')}):`);
        console.log(`    ${JSON.stringify(paragraph).slice(0, 1500)}`);
        console.log(`  → citations carry text offsets/positions? ${JSON.stringify(paragraph.citations[0]).match(/offset|position|start|index/i) ? 'LOOKS LIKE YES' : 'no position fields visible'}`);
      } else {
        console.log('  no paragraph part with citations found in sections');
      }
      const refs = doc.references ?? [];
      console.log(`  references: ${refs.length}; first two: ${JSON.stringify(refs.slice(0, 2)).slice(0, 1200)}`);
      return;
    } catch (error) {
      console.log(`  ${title}: ${error.message}`);
    }
  }
  console.log('  (no successful structured-contents response — not available on this account, or the endpoint differs)');
}

try {
  const ndjsonPath = options.ndjson ?? (await pickAndDownloadChunk());
  const { lines, total } = await sampleLines(ndjsonPath, options.articles);
  const records = lines.map((line) => JSON.parse(line));
  report(records, total);
  markupCheck(records);
  if (options.fixtures > 0) writeFixtures(records, options.fixtures);
  if (options.fixturesToDb > 0) await storeFixturesInDb(records, options.fixturesToDb);
  if (options.structured) await probeStructuredContents(records);
} catch (error) {
  console.error(`\nFailed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
