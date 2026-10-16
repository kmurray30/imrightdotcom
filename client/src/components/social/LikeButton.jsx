import { useState } from 'react';
import { api } from '../../api/client.js';

/** Liking your own article is allowed (an earlier requirement blocked it;
 * reversed — display is identical whether you're the owner or not).
 *
 * Guests can like too (no sign-up gate) — real engagement is worth counting
 * even from someone who never made an account. The server still tracks it
 * per-browser (via the guest identity POST .../like provisions if one
 * doesn't exist yet) so a duplicate like from the same browser is a no-op,
 * same idempotency guarantee an account gets. A guest can clear cookies to
 * re-like — an accepted tradeoff for prioritizing real engagement volume
 * over airtight like counts. */
export function LikeButton({ articleId, initialLiked = false, initialCount = 0 }) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !liked;
    setLiked(next);
    setCount((c) => c + (next ? 1 : -1));
    try {
      if (next) {
        await api.post(`/api/articles/${articleId}/like`);
      } else {
        await api.delete(`/api/articles/${articleId}/like`);
      }
    } catch {
      // Roll back on failure.
      setLiked(!next);
      setCount((c) => c + (next ? -1 : 1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={`like-button ${liked ? 'is-liked' : ''}`} onClick={toggle} disabled={busy}>
      {liked ? '♥' : '♡'} {count}
    </button>
  );
}
