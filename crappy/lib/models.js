/**
 * Adapter registry: every model maps the same canonical request
 * ({ prompt, negativePrompt, firstImage, lastImage } as data URIs or URLs)
 * onto its own endpoint body and parses its own result shape, so the rest
 * of the pipeline never knows which model produced a clip.
 *
 * Only entries with `verified: true` have had their field names confirmed
 * against the endpoint's OpenAPI schema. The CLI refuses to spend on an
 * unverified entry without --allow-unverified; run `crappy schema --model
 * <key>` first and fix the body if the names differ.
 */

function requireVideoUrl(json, label) {
  const url = json?.video?.url;
  if (!url) throw new Error(`${label}: no video.url in result: ${JSON.stringify(json).slice(0, 300)}`);
  return { videoUrl: url, width: json.video.width, height: json.video.height, fps: json.video.fps };
}

export const DEFAULT_VIDEO_MODEL = 'kling-v2.5-turbo-pro';

export const VIDEO_MODELS = {
  'kling-v2.5-turbo-pro': {
    id: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    verified: true,
    pricePerClipUsd: 0.35,
    nominalSeconds: 5,
    buildBody: ({ prompt, negativePrompt, firstImage, lastImage, cfgScale = 0.5 }) => ({
      prompt,
      image_url: firstImage,
      tail_image_url: lastImage,
      duration: '5',
      negative_prompt: negativePrompt,
      cfg_scale: cfgScale,
    }),
    parseResult: (json) => requireVideoUrl(json, 'kling'),
  },
  'kling-v2.5-turbo-standard': {
    id: 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video',
    verified: false,
    pricePerClipUsd: 0.25,
    nominalSeconds: 5,
    buildBody: ({ prompt, negativePrompt, firstImage, lastImage, cfgScale = 0.5 }) => ({
      prompt,
      image_url: firstImage,
      tail_image_url: lastImage,
      duration: '5',
      negative_prompt: negativePrompt,
      cfg_scale: cfgScale,
    }),
    parseResult: (json) => requireVideoUrl(json, 'kling-standard'),
  },
  'wan-2.2-flf2v': {
    id: 'fal-ai/wan/v2.2-a14b/image-to-video',
    verified: false,
    pricePerClipUsd: 0.5,
    nominalSeconds: 5,
    buildBody: ({ prompt, negativePrompt, firstImage, lastImage }) => ({
      prompt,
      image_url: firstImage,
      end_image_url: lastImage,
      negative_prompt: negativePrompt,
    }),
    parseResult: (json) => requireVideoUrl(json, 'wan'),
  },
  'hailuo-02': {
    id: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
    verified: false,
    pricePerClipUsd: 0.28,
    nominalSeconds: 6,
    buildBody: ({ prompt, firstImage, lastImage }) => ({
      prompt,
      image_url: firstImage,
      end_image_url: lastImage,
      duration: '6',
    }),
    parseResult: (json) => requireVideoUrl(json, 'hailuo'),
  },
  'pixverse-transition': {
    id: 'fal-ai/pixverse/v4.5/transition',
    verified: false,
    pricePerClipUsd: 0.3,
    nominalSeconds: 5,
    buildBody: ({ prompt, negativePrompt, firstImage, lastImage }) => ({
      prompt,
      first_image_url: firstImage,
      last_image_url: lastImage,
      negative_prompt: negativePrompt,
      duration: '5',
    }),
    parseResult: (json) => requireVideoUrl(json, 'pixverse'),
  },
  'veo-3.1-flf': {
    id: 'fal-ai/veo3.1/first-last-frame-to-video',
    verified: false,
    pricePerClipUsd: 3.2,
    nominalSeconds: 8,
    buildBody: ({ prompt, firstImage, lastImage }) => ({
      prompt,
      first_frame_url: firstImage,
      last_frame_url: lastImage,
      duration: '8s',
      generate_audio: false,
    }),
    parseResult: (json) => requireVideoUrl(json, 'veo'),
  },
};

function requireImages(json, label) {
  const images = json?.images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error(`${label}: no images[] in result: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return images.map((image) => image.url);
}

export const DEFAULT_IMAGE_MODEL = 'nano-banana';
export const DEFAULT_EDIT_MODEL = 'nano-banana-edit';

export const IMAGE_MODELS = {
  'nano-banana': {
    id: 'fal-ai/nano-banana',
    verified: true,
    pricePerImageUsd: 0.04,
    kind: 'text-to-image',
    buildBody: ({ prompt, n = 1 }) => ({ prompt, num_images: n, output_format: 'png' }),
    parseResult: (json) => requireImages(json, 'nano-banana'),
  },
  'nano-banana-edit': {
    id: 'fal-ai/nano-banana/edit',
    verified: true,
    pricePerImageUsd: 0.04,
    kind: 'image-edit',
    buildBody: ({ prompt, n = 1, images }) => ({ prompt, image_urls: images, num_images: n, output_format: 'png' }),
    parseResult: (json) => requireImages(json, 'nano-banana-edit'),
  },
  // FLUX.1 Kontext: instruction-style edits of ONE reference image that keep
  // the character's identity (shape, texture, face) far better than
  // nano-banana's restyle. Required fields (prompt, image_url) confirmed from
  // the endpoint's validation error; the rest are documented optionals.
  'flux-kontext': {
    id: 'fal-ai/flux-pro/kontext',
    verified: true,
    pricePerImageUsd: 0.04,
    kind: 'image-edit',
    buildBody: ({ prompt, n = 1, images }) => ({
      prompt,
      image_url: images[0],
      num_images: n,
      guidance_scale: 3.5,
      aspect_ratio: '1:1',
      output_format: 'png',
      safety_tolerance: '5',
    }),
    parseResult: (json) => requireImages(json, 'flux-kontext'),
  },
  'flux-kontext-max': {
    id: 'fal-ai/flux-pro/kontext/max',
    verified: true,
    pricePerImageUsd: 0.08,
    kind: 'image-edit',
    buildBody: ({ prompt, n = 1, images }) => ({
      prompt,
      image_url: images[0],
      num_images: n,
      guidance_scale: 3.5,
      aspect_ratio: '1:1',
      output_format: 'png',
      safety_tolerance: '5',
    }),
    parseResult: (json) => requireImages(json, 'flux-kontext-max'),
  },
  // FLUX.2 [pro] multi-reference edit (prompt, image_urls confirmed the same
  // way). Priced per megapixel; ~$0.05 for a 1 MP output with one input.
  'flux-2-edit': {
    id: 'fal-ai/flux-2-pro/edit',
    verified: true,
    pricePerImageUsd: 0.05,
    kind: 'image-edit',
    buildBody: ({ prompt, n = 1, images }) => ({
      prompt,
      image_urls: images,
      num_images: n,
      output_format: 'png',
    }),
    parseResult: (json) => requireImages(json, 'flux-2-edit'),
  },
};

export function getVideoModel(key = DEFAULT_VIDEO_MODEL) {
  const model = VIDEO_MODELS[key];
  if (!model) throw new Error(`unknown video model "${key}" (known: ${Object.keys(VIDEO_MODELS).join(', ')})`);
  return { key, ...model };
}

export function getImageModel(key) {
  const model = IMAGE_MODELS[key];
  if (!model) throw new Error(`unknown image model "${key}" (known: ${Object.keys(IMAGE_MODELS).join(', ')})`);
  return { key, ...model };
}
