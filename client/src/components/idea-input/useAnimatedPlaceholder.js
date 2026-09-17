import { useEffect, useRef } from 'react';

const PLACEHOLDER_SUGGESTIONS_URL = '/api/placeholder-suggestions';
const PLACEHOLDER_ANIMATION_SPEED_URL = '/config/placeholder_animation_speed.txt';
// Used only if the suggestions endpoint can't be reached (offline, DB down, etc).
const FALLBACK_PLACEHOLDER_SUGGESTIONS = ["EV's destroy the grid"];
const PLACEHOLDER_PREFIX = 'e.g. ';

// Base delays at speed multiplier 1 (see PLACEHOLDER_ANIMATION_SPEED_URL,
// a plain-text file with a single number — still config-file-based, unlike
// the suggestions pool, since there was no admin-editing ask for it).
const BASE_TYPE_DELAY_MS = 45;
const BASE_DELETE_DELAY_MS = 25;
const BASE_HOLD_DURATION_MS = 2250;
const BASE_BETWEEN_WORDS_DELAY_MS = 350;
const PAUSED_RETRY_MS = 400;

function shuffle(array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Fetches a config text file and returns its non-comment, non-blank lines.
async function fetchConfigLines(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`fetch failed (${response.status})`);
  const rawText = await response.text();
  return rawText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Cycles the belief input's placeholder overlay through a pool of example
 * beliefs, fetched from PLACEHOLDER_SUGGESTIONS_URL: types one out, holds,
 * backspaces it, then moves to the next — in random order with no repeats
 * until the whole pool has been shown once.
 *
 * Ported from index.html's pre-React-rewrite landing page (see that file's
 * git history). Renders straight into the DOM via overlayRef rather than
 * React state, on purpose: this redraws every 25-45ms while typing, far
 * more often than React re-renders should fire, and — same as index.html —
 * it needs a real overlay element to scroll to its own right edge
 * (overlayRef.current.scrollLeft = scrollWidth) so a suggestion longer than
 * the input doesn't just get clipped, which a `placeholder` attribute can't
 * do at all.
 *
 * `isPaused` (true while the input is focused, has a value, or is disabled)
 * is read through a ref that's kept in sync on every render, so toggling it
 * doesn't tear down and restart the whole animation loop.
 */
export function useAnimatedPlaceholder(overlayRef, isPaused) {
  const isPausedRef = useRef(isPaused);
  useEffect(() => {
    isPausedRef.current = isPaused;
    // Clear the overlay the instant pausing is triggered (focus/typing/
    // disabled), rather than waiting for the animation loop's own next
    // scheduled step — which, mid-hold, can be up to ~2s away — to notice
    // and clear it. Otherwise stale animated text could sit on top of what
    // the user just focused or typed for that long.
    if (isPaused && overlayRef.current) {
      overlayRef.current.textContent = '';
    }
  }, [isPaused, overlayRef]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId = null;
    let suggestions = FALLBACK_PLACEHOLDER_SUGGESTIONS;
    let speedMultiplier = 1;
    let queue = [];

    function schedule(fn, delay) {
      timeoutId = setTimeout(fn, delay);
    }

    // Renders text into the overlay and scrolls it to its own right edge —
    // exactly what a real input does once typed text overflows its width —
    // so the end of a long suggestion is always visible instead of clipped.
    function setOverlayText(text) {
      const el = overlayRef.current;
      if (!el) return;
      el.textContent = text;
      el.scrollLeft = el.scrollWidth;
    }

    function clearOverlayText() {
      const el = overlayRef.current;
      if (el) el.textContent = '';
    }

    function nextSuggestion() {
      if (queue.length === 0) queue = shuffle(suggestions);
      return queue.shift();
    }

    function canAnimate() {
      return !cancelled && !isPausedRef.current;
    }

    function runAnimation() {
      if (!canAnimate()) {
        clearOverlayText();
        schedule(runAnimation, PAUSED_RETRY_MS);
        return;
      }
      const word = PLACEHOLDER_PREFIX + nextSuggestion();
      typeWord(word, 0);
    }

    function typeWord(word, index) {
      if (!canAnimate()) {
        clearOverlayText();
        schedule(runAnimation, PAUSED_RETRY_MS);
        return;
      }
      setOverlayText(word.slice(0, index));
      if (index < word.length) {
        schedule(() => typeWord(word, index + 1), BASE_TYPE_DELAY_MS / speedMultiplier);
      } else {
        schedule(() => deleteWord(word, word.length), BASE_HOLD_DURATION_MS / speedMultiplier);
      }
    }

    function deleteWord(word, index) {
      if (!canAnimate()) {
        clearOverlayText();
        schedule(runAnimation, PAUSED_RETRY_MS);
        return;
      }
      setOverlayText(word.slice(0, index));
      if (index > 0) {
        schedule(() => deleteWord(word, index - 1), BASE_DELETE_DELAY_MS / speedMultiplier);
      } else {
        schedule(runAnimation, BASE_BETWEEN_WORDS_DELAY_MS / speedMultiplier);
      }
    }

    async function loadSuggestions() {
      try {
        const response = await fetch(PLACEHOLDER_SUGGESTIONS_URL, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`fetch failed (${response.status})`);
        const data = await response.json();
        if (Array.isArray(data.suggestions) && data.suggestions.length > 0) {
          suggestions = data.suggestions;
        }
      } catch (loadError) {
        console.error('Could not load placeholder suggestions, using fallback:', loadError);
      }
    }

    async function loadSpeed() {
      try {
        const lines = await fetchConfigLines(PLACEHOLDER_ANIMATION_SPEED_URL);
        const parsed = parseFloat(lines[0]);
        if (Number.isFinite(parsed) && parsed > 0) speedMultiplier = parsed;
      } catch (loadError) {
        console.error('Could not load placeholder animation speed, using default:', loadError);
      }
    }

    async function loadAndStart() {
      await Promise.all([loadSuggestions(), loadSpeed()]);
      if (cancelled) return;
      queue = shuffle(suggestions);
      runAnimation();
    }
    loadAndStart();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      clearOverlayText();
    };
    // Mount-once: overlayRef is a stable ref object, and isPaused is read
    // through isPausedRef instead, so this loop is never restarted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
