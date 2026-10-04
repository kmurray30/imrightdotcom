/** Thin wrapper around the existing xAI client (utils/grok.js) so Workshop's
 * provider dropdown/registry has something to list — the only real provider
 * implemented so far. A second provider is a sibling file + one registry
 * entry here, but note: the three LLM-calling stage modules still import
 * callGrokJson/callGrok from utils/grok.js directly (see run-workshop.js),
 * so making a second provider's model selectable in a real run also needs
 * one more small additive parameter on those stage functions — this registry
 * only validates/lists the choice today, it doesn't dispatch the call. */
import { callGrok, callGrokJson } from '../../../../utils/grok.js';

export const PROVIDER_ID = 'xai';
export const PROVIDER_LABEL = 'xAI (Grok)';

export async function callJson(messages, options = {}) {
  return callGrokJson(messages, options);
}

export async function callText(messages, options = {}) {
  return callGrok(messages, options);
}
