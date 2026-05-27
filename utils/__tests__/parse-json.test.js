/**
 * Unit tests for the robust JSON parser.
 * Run: node --test utils/__tests__/parse-json.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseJsonFromLlmResponse } from '../parse-json.js';

describe('parseJsonFromLlmResponse', () => {
  test('parses clean JSON object', () => {
    const input = '{"angles": [{"argument": "test", "search_queries": ["q1"]}]}';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { angles: [{ argument: 'test', search_queries: ['q1'] }] });
  });

  test('parses clean JSON array', () => {
    const input = '[{"argument": "test"}]';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, [{ argument: 'test' }]);
  });

  test('strips markdown code fences', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { key: 'value' });
  });

  test('strips markdown fences without language tag', () => {
    const input = '```\n[1, 2, 3]\n```';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  test('handles extra text after JSON (the original prod error)', () => {
    const jsonPart = '{"angles": [{"argument": "cold days", "search_queries": ["coldest days on record"]}]}';
    const input = jsonPart + '\n\nHere are the angles I generated for your topic.';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, {
      angles: [{ argument: 'cold days', search_queries: ['coldest days on record'] }],
    });
  });

  test('handles extra text before JSON', () => {
    const input = 'Here is the result:\n\n{"key": "value"}';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { key: 'value' });
  });

  test('handles text before and after JSON', () => {
    const input = 'Response:\n[{"argument": "test"}]\nDone!';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, [{ argument: 'test' }]);
  });

  test('handles multiple JSON objects (takes the first complete one)', () => {
    const input = '{"a": 1}\n{"b": 2}';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { a: 1 });
  });

  test('handles nested braces in strings', () => {
    const input = '{"text": "a {nested} brace", "count": 1}';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { text: 'a {nested} brace', count: 1 });
  });

  test('handles escaped quotes in strings', () => {
    const input = '{"text": "she said \\"hello\\"", "ok": true}';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { text: 'she said "hello"', ok: true });
  });

  test('handles the real Grok "arguments" key response from prod', () => {
    const input = `{ "arguments": [ { "argument": "Historical government documents confirm UFOs", "search_queries": ["U.S. government UFO reports", "Pentagon UFO report 2021"] }, { "argument": "Politicians age slowly", "search_queries": ["U.S. politicians age timeline"] } ] }`;
    const result = parseJsonFromLlmResponse(input);
    assert.strictEqual(result.arguments.length, 2);
    assert.strictEqual(result.arguments[0].argument, 'Historical government documents confirm UFOs');
  });

  test('handles whitespace and newlines around JSON', () => {
    const input = '\n\n  {"key": "value"}  \n\n';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { key: 'value' });
  });

  test('throws on completely non-JSON input', () => {
    assert.throws(
      () => parseJsonFromLlmResponse('This is just text with no JSON at all.'),
      /Unable to extract JSON/
    );
  });

  test('throws on empty input', () => {
    assert.throws(
      () => parseJsonFromLlmResponse(''),
      /Empty or non-string/
    );
  });

  test('throws on null input', () => {
    assert.throws(
      () => parseJsonFromLlmResponse(null),
      /Empty or non-string/
    );
  });

  test('handles deeply nested JSON', () => {
    const input = '{"a": {"b": {"c": [1, 2, {"d": true}]}}}';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { a: { b: { c: [1, 2, { d: true }] } } });
  });

  test('handles JSON with trailing comma issue by extracting valid portion', () => {
    const input = 'Sure! Here you go:\n{"angles": [{"argument": "test", "search_queries": ["q"]}]}\nLet me know if you need more.';
    const result = parseJsonFromLlmResponse(input);
    assert.deepStrictEqual(result, { angles: [{ argument: 'test', search_queries: ['q'] }] });
  });
});
