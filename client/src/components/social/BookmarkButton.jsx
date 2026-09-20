import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { GuestPrompt } from '../auth/GuestPrompt.jsx';
import { BookmarkFolderModal } from './BookmarkFolderModal.jsx';

/** First click on an un-bookmarked article: quick-add to the default
 * "Unsorted" folder, icon fills. Second click on the filled icon: open the
 * folder-management widget instead of unbookmarking outright — exactly the
 * interaction the user asked for. Bookmarking your own article is allowed
 * (unlike liking it). */
export function BookmarkButton({ articleId }) {
  const { isGuest } = useAuth();
  const [folders, setFolders] = useState(null); // null = not loaded yet
  const [showModal, setShowModal] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isGuest) return;
    api
      .get(`/api/articles/${articleId}/bookmark-folders`)
      .then((data) => setFolders(data.folders))
      .catch(() => {});
  }, [articleId, isGuest]);

  if (isGuest) return <GuestPrompt message="Sign up to bookmark this" />;

  const isBookmarked = folders?.some((f) => f.checked) ?? false;

  async function handleClick() {
    if (busy) return;
    if (folders && isBookmarked) {
      setShowModal(true);
      return;
    }
    setBusy(true);
    try {
      const data = await api.post(`/api/articles/${articleId}/bookmark`);
      setFolders(data.folders);
    } catch {
      // Leave state as-is; the button just stays unfilled.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={`bookmark-button ${isBookmarked ? 'is-bookmarked' : ''}`} onClick={handleClick} disabled={busy}>
        {isBookmarked ? '🔖' : '📑'} Save
      </button>
      {showModal && folders && (
        <BookmarkFolderModal
          articleId={articleId}
          folders={folders}
          onChange={setFolders}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}
