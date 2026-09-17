import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { GuestPrompt } from '../auth/GuestPrompt.jsx';

/** Requirement: can't like your own article (but can bookmark it — see
 * BookmarkButton). isOwnArticle hides the control entirely rather than
 * showing it disabled, since there's nothing useful to explain there. */
export function LikeButton({ articleId, initialLiked = false, initialCount = 0, isOwnArticle }) {
  const { isGuest } = useAuth();
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  if (isOwnArticle) return null;
  if (isGuest) return <GuestPrompt message="Sign up to like this" />;

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
