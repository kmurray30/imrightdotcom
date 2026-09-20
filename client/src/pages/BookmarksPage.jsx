import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export function BookmarksPage() {
  const [folders, setFolders] = useState([]);

  useEffect(() => {
    api
      .get('/api/bookmark-folders')
      .then((data) => setFolders(data.folders ?? []))
      .catch(() => setFolders([]));
  }, []);

  return (
    <div className="bookmarks-page">
      <h1>Your bookmarks</h1>
      {folders.length === 0 && <p className="empty-state">No folders yet — bookmark an article to create one.</p>}
      <ul className="folder-summary-list">
        {folders.map((folder) => (
          <li key={folder.id}>{folder.name}</li>
        ))}
      </ul>
    </div>
  );
}
