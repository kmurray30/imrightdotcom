import { useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { api } from '../../api/client.js';

/** A public article that already has activity on it needs a stronger
 * confirmation than a plain "are you sure" — typing out the account's own
 * email, the same friction pattern used elsewhere for a genuinely
 * destructive, hard-to-undo action. A private article, or a public one
 * nobody has interacted with yet, only needs the plain confirmation. */
function needsEmailConfirm(article) {
  const hasInteraction = (article.likeCount || 0) + (article.commentCount || 0) + (article.bookmarkCount || 0) > 0;
  return article.isPublic && hasInteraction;
}

export function DeleteArticleModal({ article, onClose, onDeleted }) {
  const { user } = useAuth();
  const [emailConfirm, setEmailConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const requiresEmail = needsEmailConfirm(article);
  const emailMatches = !requiresEmail || emailConfirm.trim().toLowerCase() === (user?.email || '').toLowerCase();

  async function handleDelete() {
    if (!emailMatches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/articles/${article.id}`);
      onDeleted();
    } catch {
      setError('Could not delete this article. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Delete this article?</h3>
        <p className="delete-warning">
          This permanently deletes the article{requiresEmail ? ', including its likes, comments, and bookmarks,' : ''} for
          everyone. This can't be undone.
        </p>
        {requiresEmail && (
          <label className="delete-confirm-label">
            This article is public and has activity on it. Type your account email ({user.email}) to confirm.
            <input
              type="email"
              value={emailConfirm}
              onChange={(e) => setEmailConfirm(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="delete-modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button-danger" onClick={handleDelete} disabled={busy || !emailMatches}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
