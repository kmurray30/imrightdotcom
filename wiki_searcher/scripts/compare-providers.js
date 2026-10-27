#!/usr/bin/env node
/**
 * Side-by-side comparison of the wiki search providers on real claims: runs
 * stage 1 (angles, one LLM call) once per claim, then stages 2–4 (search,
 * filter, citation extraction with link checks) with each provider on the
 * same angles, and writes compare-providers.html (and .json): per search
 * term, the citations each provider found, plus time per stage.
 *
 * Usage: node wiki_searcher/scripts/compare-providers.js ["claim" ...]
 *   PROVIDERS (default "mediawiki,spans")
 */
import fs from 'fs';
import { loadEnv } from '../../imright/load-env.js';

loadEnv();
const { generateAngles } = await import('../../conspirator/index.js');
const { fetchWiki } = await import('../index.js');
const { filterWiki } = await import('../../wiki_filterer/index.js');
const { extract } = await import('../../ref_extractor/index.js');
const { getPool } = await import('../../imright/scripts/db.js');

// Recent real claims from the site's logs.
const DEFAULT_CLAIMS = [
  'we have a finite number of heartbeats',
  'Who important was on the titanic',
  'Gabe newell is our Lord God and savior',
  'Eating poop is healthy',
  'i like broccoli',
];
const claims = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CLAIMS;
const providers = (process.env.PROVIDERS || 'mediawiki,spans').split(',').map((p) => p.trim()).filter(Boolean);

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

const report = [];
for (const claim of claims) {
  console.log(`\n"${claim}": generating angles...`);
  const conspiracy = await generateAngles(claim);
  const entry = { claim, angles: conspiracy.angles, providers: {} };
  for (const provider of providers) {
    process.stdout.write(`  ${provider}: `);
    try {
      const fetched = await timed(() => fetchWiki(conspiracy, { provider }));
      const filtered = await timed(() => filterWiki(conspiracy, fetched.value));
      const extracted = await timed(() => extract(conspiracy, filtered.value, {}));
      entry.providers[provider] = {
        ms: { search: fetched.ms, filter: filtered.ms, extract: extracted.ms },
        extracted: extracted.value.extracted,
        deadLinks: extracted.value.stats.linkStats?.deadLinksCount ?? 0,
      };
      const count = Object.values(extracted.value.extracted).reduce((n, list) => n + list.length, 0);
      console.log(`${count} citations, ${((fetched.ms + filtered.ms + extracted.ms) / 1000).toFixed(1)} s`);
    } catch (error) {
      entry.providers[provider] = { error: error.message };
      console.log(`failed: ${error.message}`);
    }
  }
  report.push(entry);
  // One line per claim on stdout too, for runs whose files don't survive (e.g. a one-off Railway service).
  const compact = {
    claim,
    angles: entry.angles,
    providers: Object.fromEntries(
      Object.entries(entry.providers).map(([name, r]) => [
        name,
        r.error
          ? { error: r.error }
          : {
              ms: Object.fromEntries(Object.entries(r.ms).map(([k, v]) => [k, Math.round(v)])),
              deadLinks: r.deadLinks,
              extracted: Object.fromEntries(
                Object.entries(r.extracted).map(([term, list]) => [
                  term,
                  list.map((c) => ({ link: c.link, title: c.title, article_title: c.article_title, content: String(c.content ?? '').slice(0, 400) })),
                ])
              ),
            },
      ])
    ),
  };
  console.log(`COMPARE_RESULT ${JSON.stringify(compact)}`);
}

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
function column(result, term) {
  if (!result) return '<td></td>';
  if (result.error) return `<td class="error">${escape(result.error)}</td>`;
  const items = result.extracted[term] ?? [];
  if (!items.length) return '<td class="none">none</td>';
  return `<td>${items
    .map((c) => `<div class="cite"><a href="${escape(c.link)}">${escape(c.title || host(c.link))}</a> <span class="host">${escape(host(c.link))}</span><div class="content">${escape(c.content).slice(0, 300)}</div><div class="article">from: ${escape(c.article_title)}</div></div>`)
    .join('')}</td>`;
}
const sections = report
  .map((entry) => {
    const terms = [...new Set(providers.flatMap((p) => Object.keys(entry.providers[p]?.extracted ?? {})))];
    const timing = providers
      .map((p) => {
        const r = entry.providers[p];
        if (!r || r.error) return `${p}: failed`;
        const total = r.ms.search + r.ms.filter + r.ms.extract;
        return `${p}: ${(total / 1000).toFixed(1)} s (search ${(r.ms.search / 1000).toFixed(1)}, citations ${(r.ms.extract / 1000).toFixed(1)}), ${Object.values(r.extracted).flat().length} citations`;
      })
      .join(' · ');
    const rows = terms.map((term) => `<tr><th>${escape(term)}</th>${providers.map((p) => column(entry.providers[p], term)).join('')}</tr>`).join('');
    return `<section><h2>${escape(entry.claim)}</h2><p class="timing">${escape(timing)}</p><table><thead><tr><th>Search term</th>${providers.map((p) => `<th>${escape(p)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>`;
  })
  .join('');
fs.writeFileSync(
  'compare-providers.html',
  `<!doctype html><meta charset="utf-8"><title>Provider comparison</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#222}h2{margin-top:36px}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}thead th{background:#f4f4f4}tbody th{width:18%;font-weight:600}
.cite{margin-bottom:10px}.host{color:#888;font-size:12px}.content{color:#444;font-size:13px}.article{color:#999;font-size:12px}
.timing{color:#555}.error{color:#b00}.none{color:#999}</style><h1>Wiki search providers: ${escape(providers.join(' vs '))}</h1>${sections}`
);
fs.writeFileSync('compare-providers.json', JSON.stringify(report, null, 2));
console.log('\nWrote compare-providers.html and compare-providers.json');
await getPool()?.end();
process.exit(0);
