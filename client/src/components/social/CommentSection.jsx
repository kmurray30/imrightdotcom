import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useGuestGate } from '../../context/GuestGateContext.jsx';

function CommentItem({ comment }) {
  // Liking a comment is guest-ok, same reasoning as LikeButton — posting a
  // comment (below, in CommentSection) is still account-gated.
  const [liked, setLiked] = useState(comment.likedByViewer ?? false);
  const [count, setCount] = useState(comment.likeCount);
  const [busy, setBusy] = useState(false);

  async function toggleLike() {
    if (busy) return;
    setBusy(true);
    const next = !liked;
    setLiked(next);
    setCount((c) => c + (next ? 1 : -1));
    try {
      if (next) {
        await api.post(`/api/comments/${comment.id}/like`);
      } else {
        await api.delete(`/api/comments/${comment.id}/like`);
      }
    } catch {
      setLiked(!next);
      setCount((c) => c + (next ? -1 : 1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="comment-item">
      <p className="comment-author">{comment.displayName || comment.username || 'Anonymous'}</p>
      <p className="comment-body">{comment.body}</p>
      <button type="button" className={`comment-like ${liked ? 'is-liked' : ''}`} onClick={toggleLike} disabled={busy}>
        {liked ? '♥' : '♡'} {count}
      </button>
    </li>
  );
}

export function CommentSection({ articleId }) {
  const { isGuest } = useAuth();
  const { promptSignup } = useGuestGate();
  // One seed per time this section mounts (article page load) — see the
  // plan's Comment Ranking section: reused across pagination of this view,
  // regenerated on a fresh page load, so ordering is stable while reading.
  const seed = useMemo(() => crypto.randomUUID(), [articleId]);
  const [comments, setComments] = useState([]);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get(`/api/articles/${articleId}/comments?seed=${seed}`)
      .then((data) => setComments(data.comments ?? []))
      .catch(() => setComments([]));
  }, [articleId, seed]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (isGuest) {
      promptSignup('comment');
      return;
    }
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const { comment } = await api.post(`/api/articles/${articleId}/comments`, { body: trimmed });
      setComments((prev) => [{ ...comment, likeCount: 0 }, ...prev]);
      setBody('');
    } catch {
      // Leave the draft in the box so the user can retry.
    } finally {
      setSubmitting(false);
    }
  }

  // On a phone, the on-screen keyboard commonly covers the Post button
  // below the textarea (a real report: "still no way to submit comments on
  // mobile") — Enter-to-submit means the keyboard's own return/send key
  // works without the button ever needing to be visible. Shift+Enter still
  // inserts a newline, the standard chat-input convention.
  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit(event);
    }
  }

  return (
    <section className="comment-section">
      <h2>Comments</h2>
      <form onSubmit={handleSubmit} className="comment-composer">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={2000}
          placeholder="Add a comment..."
          enterKeyHint="send"
        />
        <button type="submit" className="button-primary" disabled={submitting || (!isGuest && !body.trim())}>
          Post
        </button>
      </form>
      <ul className="comment-list">
        {comments.map((comment) => (
          <CommentItem key={comment.id} comment={comment} />
        ))}
      </ul>
      {comments.length === 0 && <p className="empty-state">No comments yet.</p>}
    </section>
  );
}
