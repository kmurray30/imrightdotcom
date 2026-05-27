/**
 * Tests for the angle extraction logic in conspirator.
 * Run: node --test conspirator/__tests__/extract-angles.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

/**
 * Duplicated from conspirator/index.js for testability.
 * This mirrors the extractAnglesArray function exactly.
 */
function extractAnglesArray(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.angles) && parsed.angles.length > 0) {
      return parsed.angles;
    }
    if (Array.isArray(parsed.arguments) && parsed.arguments.length > 0) {
      return parsed.arguments;
    }
    const arrayValues = Object.values(parsed).filter(Array.isArray);
    if (arrayValues.length === 1 && arrayValues[0].length > 0) {
      return arrayValues[0];
    }
  }

  return [];
}

describe('extractAnglesArray', () => {
  test('handles bare array response', () => {
    const input = [
      { argument: 'test1', search_queries: ['q1'] },
      { argument: 'test2', search_queries: ['q2'] },
    ];
    const result = extractAnglesArray(input);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].argument, 'test1');
  });

  test('handles { angles: [...] } wrapper', () => {
    const input = {
      angles: [
        { argument: 'cold days', search_queries: ['coldest days'] },
      ],
    };
    const result = extractAnglesArray(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].argument, 'cold days');
  });

  test('handles { arguments: [...] } wrapper (the prod bug)', () => {
    const input = {
      arguments: [
        { argument: 'UFO reports', search_queries: ['government UFO reports'] },
        { argument: 'politicians age', search_queries: ['politicians age timeline'] },
      ],
    };
    const result = extractAnglesArray(input);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].argument, 'UFO reports');
  });

  test('handles unknown key name (single array value)', () => {
    const input = {
      bad_faith_angles: [
        { argument: 'test', search_queries: ['q'] },
      ],
    };
    const result = extractAnglesArray(input);
    assert.strictEqual(result.length, 1);
  });

  test('prefers "angles" key over "arguments"', () => {
    const input = {
      angles: [{ argument: 'from angles', search_queries: [] }],
      arguments: [{ argument: 'from arguments', search_queries: [] }],
    };
    const result = extractAnglesArray(input);
    assert.strictEqual(result[0].argument, 'from angles');
  });

  test('returns empty array for non-array object', () => {
    const input = { some_string: 'not an array' };
    const result = extractAnglesArray(input);
    assert.deepStrictEqual(result, []);
  });

  test('returns empty array for empty angles', () => {
    const input = { angles: [] };
    const result = extractAnglesArray(input);
    assert.deepStrictEqual(result, []);
  });

  test('returns empty array for null', () => {
    const result = extractAnglesArray(null);
    assert.deepStrictEqual(result, []);
  });

  test('handles object with multiple arrays (ambiguous) — returns empty', () => {
    const input = {
      list_a: [{ argument: 'a' }],
      list_b: [{ argument: 'b' }],
    };
    const result = extractAnglesArray(input);
    assert.deepStrictEqual(result, []);
  });
});
