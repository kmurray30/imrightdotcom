/**
 * Run: node --test crappy/__tests__/placeholder.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { DEFAULTS } from '../lib/config.js';
import { alphaBbox, anchorOf } from '../lib/frames.js';
import {
  renderPlaceholderFrame,
  renderPlaceholderHubSvg,
  renderPlaceholderSvg,
} from '../lib/placeholder.js';
import { countOpaque } from './helpers.js';

const box = { ...DEFAULTS };
const N = box.frameCount;

describe('placeholder determinism', () => {
  test('slither frame 0 equals frame N-1 (seamless loop)', () => {
    assert.strictEqual(renderPlaceholderSvg('slither', 0, N, box), renderPlaceholderSvg('slither', N - 1, N, box));
    assert.notStrictEqual(renderPlaceholderSvg('slither', 0, N, box), renderPlaceholderSvg('slither', 5, N, box));
  });

  test('uncurl starts on the curled hub and ends on the snake hub', () => {
    assert.strictEqual(renderPlaceholderSvg('uncurl', 0, N, box), renderPlaceholderHubSvg('curled', N, box));
    assert.strictEqual(renderPlaceholderSvg('uncurl', N - 1, N, box), renderPlaceholderHubSvg('snake', N, box));
  });

  test('curl is uncurl reversed and slither starts on the snake hub', () => {
    assert.strictEqual(renderPlaceholderSvg('curl', 0, N, box), renderPlaceholderHubSvg('snake', N, box));
    assert.strictEqual(renderPlaceholderSvg('curl', N - 1, N, box), renderPlaceholderHubSvg('curled', N, box));
    assert.strictEqual(renderPlaceholderSvg('slither', 0, N, box), renderPlaceholderHubSvg('snake', N, box));
  });
});

describe('placeholder rasterisation', () => {
  test('frames are the box size, grounded on the anchor, with a visible body', async () => {
    for (const [clip, i] of [
      ['uncurl', 0],
      ['uncurl', 12],
      ['slither', 7],
      ['curl', N - 1],
    ]) {
      const frame = await renderPlaceholderFrame(clip, i, N, box);
      assert.strictEqual(frame.width, box.frameWidth);
      assert.strictEqual(frame.height, box.frameHeight);
      assert.ok(countOpaque(frame.data) > 2000, `${clip}#${i} too few opaque pixels`);
      const bbox = alphaBbox(frame.data, frame.width, frame.height, 128);
      const a = anchorOf(bbox);
      assert.ok(Math.abs(a.y - (box.frameHeight - box.anchorBottomMargin)) <= 2, `${clip}#${i} bottom at ${a.y}`);
      assert.ok(Math.abs(a.x - box.frameWidth / 2) <= 2, `${clip}#${i} centre at ${a.x}`);
      assert.ok(bbox.x0 >= 0 && bbox.x1 < box.frameWidth && bbox.y0 >= 0);
    }
  });
});
