import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isAbbreviationSoup } from '../providers/spans.js';

// Real spans from wiki_citation_spans (seen in check-span-search.js and the provider comparison).
describe('isAbbreviationSoup', () => {
  test('flags standings-table rows made of codes and numbers', () => {
    assert.strictEqual(isAbbreviationSoup('Pos. Driver BHR JDH IMO CAT MON BAK SIL RBR LEC HUN SPA ZAN MNZ YMC Points SR FR SR FR SR FR SR FR SR FR'), true);
    assert.strictEqual(isAbbreviationSoup('Pos. Team No. SMP SYM MEL WAN WIN HID TOW BEN SAN PUK BAT SUR ADE Pen. Pts. 1 Triple Eight Race Engineering 88 1 2 3 1 2'), true);
  });

  test('keeps ordinary table rows and prose', () => {
    assert.strictEqual(isAbbreviationSoup('Name: Miss Kornelia Theodosia Andrews; Date of birth: 12 August 1849; Date of death: 4 December 1913; Age at time of disaster: 62'), false);
    assert.strictEqual(isAbbreviationSoup('In humans, the TAS1R2 gene is located on chromosome 1 at band p36.13 (coordinates 18,839,599–18,859,…)'), false);
    assert.strictEqual(isAbbreviationSoup('Some critics argue that existing exposure limits are too lenient or influenced by industry lobbying.'), false);
    assert.strictEqual(isAbbreviationSoup(''), false);
  });
});
