/**
 * Prompt loading. Prompts live as plain text in crappy/prompts/ so they can
 * be tweaked without touching code.
 */
import fs from 'fs';
import path from 'path';
import { CLIPS, HUB_NAMES, PROMPTS_DIR } from './config.js';

const SAFE_WORD_PATTERN = /\s*\(the classic poop-emoji look\)/g;

export function loadPrompt(name) {
  const file = path.join(PROMPTS_DIR, `${name}.txt`);
  if (!fs.existsSync(file)) throw new Error(`missing prompt file ${file}`);
  return fs.readFileSync(file, 'utf8').trim().replace(/\s+/g, ' ');
}

/** Drop the explicit poop reference for models whose filters object to it. */
export function applySafeWords(text) {
  return text.replace(SAFE_WORD_PATTERN, '');
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.safeWords]
 * @param {boolean} [opts.withReference] use the prompt written for a style-reference image
 *   (hub-<hub>-ref.txt) instead of the text-only one.
 */
export function composeHubPrompt(hub, { safeWords = false, withReference = false } = {}) {
  if (!HUB_NAMES.includes(hub)) throw new Error(`unknown hub "${hub}"`);
  const text = loadPrompt(withReference ? `hub-${hub}-ref` : `hub-${hub}`);
  return safeWords ? applySafeWords(text) : text;
}

export function composeClipPrompt(clip, { safeWords = false } = {}) {
  if (!CLIPS[clip]) throw new Error(`unknown clip "${clip}"`);
  const text = `${loadPrompt(`clip-${clip}`)} ${loadPrompt('clip-common')}`;
  return safeWords ? applySafeWords(text) : text;
}

export function negativePrompt() {
  return loadPrompt('negative');
}
