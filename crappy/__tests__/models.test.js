/**
 * Run: node --test crappy/__tests__/models.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { IMAGE_MODELS, VIDEO_MODELS, getImageModel, getVideoModel } from '../lib/models.js';
import { elideDataUris, summarizeSchema } from '../lib/fal-client.js';
import { applySafeWords, composeClipPrompt, composeHubPrompt, negativePrompt } from '../lib/prompts.js';

describe('model registry', () => {
  test('every entry has the adapter surface', () => {
    for (const [key, model] of Object.entries({ ...VIDEO_MODELS, ...IMAGE_MODELS })) {
      assert.strictEqual(typeof model.id, 'string', key);
      assert.strictEqual(typeof model.buildBody, 'function', key);
      assert.strictEqual(typeof model.parseResult, 'function', key);
      assert.strictEqual(typeof model.verified, 'boolean', key);
    }
  });

  test('kling body pins both frames and the 5s minimum', () => {
    const model = getVideoModel('kling-v2.5-turbo-pro');
    assert.strictEqual(model.verified, true);
    const body = model.buildBody({
      prompt: 'p',
      negativePrompt: 'n',
      firstImage: 'data:image/png;base64,AAA',
      lastImage: 'data:image/png;base64,BBB',
    });
    assert.deepStrictEqual(body, {
      prompt: 'p',
      image_url: 'data:image/png;base64,AAA',
      tail_image_url: 'data:image/png;base64,BBB',
      duration: '5',
      negative_prompt: 'n',
      cfg_scale: 0.5,
    });
    assert.deepStrictEqual(model.parseResult({ video: { url: 'https://x/v.mp4' } }).videoUrl, 'https://x/v.mp4');
    assert.throws(() => model.parseResult({}), /no video\.url/);
  });

  test('image models parse urls and unknown keys throw', () => {
    assert.deepStrictEqual(getImageModel('nano-banana').parseResult({ images: [{ url: 'u1' }, { url: 'u2' }] }), ['u1', 'u2']);
    assert.deepStrictEqual(getImageModel('flux-kontext').buildBody({ prompt: 'p', n: 4, images: ['d'] }), {
      prompt: 'p',
      image_url: 'd',
      num_images: 4,
      guidance_scale: 3.5,
      aspect_ratio: '1:1',
      output_format: 'png',
      safety_tolerance: '5',
    });
    assert.deepStrictEqual(getImageModel('flux-2-edit').buildBody({ prompt: 'p', n: 1, images: ['d'] }), {
      prompt: 'p',
      image_urls: ['d'],
      num_images: 1,
      output_format: 'png',
    });
    assert.deepStrictEqual(getImageModel('nano-banana-edit').buildBody({ prompt: 'p', n: 2, images: ['d'] }), {
      prompt: 'p',
      image_urls: ['d'],
      num_images: 2,
      output_format: 'png',
    });
    assert.throws(() => getVideoModel('nope'), /unknown video model/);
  });
});

describe('fal helpers', () => {
  test('elideDataUris hides base64 payloads but keeps everything else', () => {
    const out = elideDataUris({ a: 'data:image/png;base64,AAAA', b: ['x', 'data:y'], c: 1 });
    assert.strictEqual(out.a, '<data-uri 26 chars>');
    assert.deepStrictEqual(out.b, ['x', '<data-uri 6 chars>']);
    assert.strictEqual(out.c, 1);
  });

  test('summarizeSchema lists input fields with enums and required', () => {
    const summary = summarizeSchema({
      components: {
        schemas: {
          KlingInput: {
            required: ['prompt', 'image_url'],
            properties: { prompt: { type: 'string' }, duration: { type: 'string', enum: ['5', '10'], default: '5' } },
          },
          Output: { properties: { video: {} } },
        },
      },
    });
    assert.strictEqual(summary.length, 1);
    assert.deepStrictEqual(summary[0].required, ['prompt', 'image_url']);
    assert.ok(summary[0].fields.some((f) => f.includes('enum ["5","10"]')));
  });
});

describe('prompts', () => {
  test('clip prompts carry the common static-camera suffix', () => {
    for (const clip of ['uncurl', 'slither', 'curl']) {
      const prompt = composeClipPrompt(clip);
      assert.ok(prompt.includes('static camera'), clip);
      assert.ok(prompt.includes('slow motion'), clip);
    }
    assert.ok(composeClipPrompt('slither').includes('one full cycle'));
    assert.ok(negativePrompt().includes('camera movement'));
  });

  test('safe words strip the poop reference from the hub prompt', () => {
    const plain = composeHubPrompt('snake');
    assert.ok(plain.includes('poop-emoji'));
    const safe = composeHubPrompt('snake', { safeWords: true });
    assert.ok(!safe.includes('poop'));
    assert.strictEqual(applySafeWords('x (the classic poop-emoji look) y'), 'x y');
  });

  test('the reference-image hub prompt describes the style transfer and stays safe-word clean', () => {
    const ref = composeHubPrompt('snake', { withReference: true });
    assert.ok(ref.includes('Turn this character into a snake'));
    assert.ok(ref.includes('#00FF00'));
    assert.ok(ref.includes('no drop shadow'));
    assert.notStrictEqual(ref, composeHubPrompt('snake'));
    assert.ok(!composeHubPrompt('snake', { withReference: true, safeWords: true }).includes('poop'));
  });
});
