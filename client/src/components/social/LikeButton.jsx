import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useGuestGate } from '../../context/GuestGateContext.jsx';

/** Liking your own article is allowed (an earlier requirement blocked it;
 * reversed — display is identical whether you're the owner or not). */
export function LikeButton({ articleId, initialLiked = false, initialCount = 0 }) {
  const { isGuest } = useAuth();
  const { promptSignup } = useGuestGate();
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (isGuest) {
      promptSignup('like this');
      return;
    }
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
