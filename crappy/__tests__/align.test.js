/**
 * Run: node --test crappy/__tests__/align.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { alignFrame, computeGlobalScale } from '../lib/align.js';
import { DEFAULTS, anchorFor } from '../lib/config.js';
import { alphaBbox, anchorOf } from '../lib/frames.js';
import { BROWN, fillRect, makeFrame } from './helpers.js';

const box = { ...DEFAULTS };

describe('alignFrame', () => {
  test('puts the source anchor on the box anchor at scale 1', async () => {
    const frame = fillRect(makeFrame(600, 500), 40, 30, 100, 80, BROWN);
    const bbox = alphaBbox(frame.data, 600, 500);
    const out = await alignFrame(frame, anchorOf(bbox), 1, box);
    assert.strictEqual(out.length, box.frameWidth * box.frameHeight * 4);
    const outBbox = alphaBbox(out, box.frameWidth, box.frameHeight);
    const a = anchorOf(outBbox);
    const target = anchorFor(box);
    assert.ok(Math.abs(a.x - target.x) <= 1, `x ${a.x}`);
    assert.ok(Math.abs(a.y - target.y) <= 1, `y ${a.y}`);
    assert.strictEqual(outBbox.x1 - outBbox.x0 + 1, 100);
  });

  test('scales the source before placing it', async () => {
    const frame = fillRect(makeFrame(600, 500), 40, 30, 100, 80, BROWN);
    const bbox = alphaBbox(frame.data, 600, 500);
    const out = await alignFrame(frame, anchorOf(bbox), 0.5, box);
    const outBbox = alphaBbox(out, box.frameWidth, box.frameHeight, 128);
    assert.ok(Math.abs(outBbox.x1 - outBbox.x0 + 1 - 50) <= 2);
    assert.ok(Math.abs(anchorOf(outBbox).y - anchorFor(box).y) <= 1);
  });

  test('clips a blob that would spill past the box instead of throwing', async () => {
    const frame = fillRect(makeFrame(300, 300), 0, 0, 300, 300, BROWN);
    const out = await alignFrame(frame, { x: 5, y: 295 }, 1, box);
    assert.strictEqual(out.length, box.frameWidth * box.frameHeight * 4);
    const outBbox = alphaBbox(out, box.frameWidth, box.frameHeight);
    assert.ok(outBbox, 'something was drawn');
    assert.ok(outBbox.x1 <= box.frameWidth - 1);
  });
});

describe('computeGlobalScale', () => {
  const hubs = {
    snake: { bbox: { x0: 100, y0: 300, x1: 900, y1: 700 }, anchor: { x: 500, y: 700 } },
    curled: { bbox: { x0: 300, y0: 350, x1: 700, y1: 700 }, anchor: { x: 500, y: 700 } },
  };

  test('targets the snake height ratio when nothing limits it', () => {
    const clips = {
      slither: {
        videoSnakeHeight: 200,
        frames: [{ bbox: { x0: 50, y0: 150, x1: 450, y1: 350 }, anchor: { x: 250, y: 350 } }],
      },
    };
    const s = computeGlobalScale({ hubs, clips, box });
    const hubSnakeH = 401;
    const expected = (box.snakeHeightRatio * box.frameHeight) / hubSnakeH;
    assert.ok(Math.abs(s.sHub - expected) < 1e-9 || s.limiting === 'fit');
    // video px are ~2x hub px here (200 vs 401), so the clip scale is ~2x the hub scale
    assert.ok(Math.abs(s.sClips.slither / s.sHub - 401 / 200) < 1e-9);
    assert.ok(s.snakeHeightPx > 0);
  });

  test('shrinks to fit a very wide frame inside the box', () => {
    const clips = {
      slither: {
        videoSnakeHeight: 401,
        frames: [{ bbox: { x0: 0, y0: 600, x1: 3999, y1: 700 }, anchor: { x: 2000, y: 700 } }],
      },
    };
    const s = computeGlobalScale({ hubs, clips, box });
    assert.strictEqual(s.limiting, 'fit');
    const half = (box.frameWidth / 2 - box.fitMarginX) / 2000;
    assert.ok(Math.abs(s.sHub - half) < 1e-9);
  });
});
