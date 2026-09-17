import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { GuestPrompt } from '../auth/GuestPrompt.jsx';

/** Only rendered for the article's own owner (see ArticlePage). Guests can't
 * publish at all (requirement 8) — shown here in case an owner is somehow
 * still a guest by the time this renders, though ArticlePage already only
 * shows this to the owner, and a guest owner would need to sign up first. */
export function VisibilityToggle({ articleId, initialIsPublic, onChange }) {
  const { isGuest } = useAuth();
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [busy, setBusy] = useState(false);

  if (isGuest) return <GuestPrompt message="Sign up to make this article public" />;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const { article } = await api.patch(`/api/articles/${articleId}/visibility`, { isPublic: !isPublic });
      setIsPublic(article.isPublic);
      onChange?.(article.isPublic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="visibility-toggle">
      <input type="checkbox" checked={isPublic} onChange={toggle} disabled={busy} />
      {isPublic ? 'Public' : 'Private'}
    </label>
  );
}
