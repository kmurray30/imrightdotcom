/**
 * Configuration constants for the echocheck / imright.io app.
 * API endpoints, model names, loading messages, and default UI strings.
 */

// --- xAI API ---
// xAI Grok 4.1 fast non-reasoning — OpenAI-compatible chat completions API
export const XAI_MODEL = "grok-4-1-fast-non-reasoning";
export const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";

// --- Loading UI ---
export const LOADING_MESSAGES = [
  "Cherry-picking evidence...",
  "Exposing the conspiracy...",
  "Saying what everyone is thinking...",
  "Ignoring context...",
  "Finding the perfect headline...",
  "Confirming your suspicions...",
  "Filtering out dissent..."
];

export const DEFAULT_BUTTON_TEXT = "Prove me right!";
