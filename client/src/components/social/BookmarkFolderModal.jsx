import { useState } from 'react';
import { api } from '../../api/client.js';

export function BookmarkFolderModal({ articleId, folders, onChange, onClose }) {
  const [newFolderName, setNewFolderName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function toggleFolder(folder) {
    setBusy(true);
    try {
      const data = await api.put(`/api/articles/${articleId}/bookmark-folders/${folder.id}`, {
        checked: !folder.checked,
      });
      onChange(data.folders);
    } catch {
      setError('Could not update that folder.');
    } finally {
      setBusy(false);
    }
  }

  async function createFolder(event) {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const { folder } = await api.post('/api/bookmark-folders', { name });
      const data = await api.put(`/api/articles/${articleId}/bookmark-folders/${folder.id}`, { checked: true });
      onChange(data.folders);
      setNewFolderName('');
    } catch (err) {
      setError(err.code === 'folder_name_taken' ? 'You already have a folder with that name.' : 'Could not create that folder.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Save to...</h3>
        <ul className="folder-list">
          {folders.map((folder) => (
            <li key={folder.id}>
              <label>
                <input type="checkbox" checked={folder.checked} disabled={busy} onChange={() => toggleFolder(folder)} />
                {folder.name}
              </label>
            </li>
          ))}
        </ul>
        <form onSubmit={createFolder} className="new-folder-form">
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="New folder name"
            maxLength={60}
          />
          <button type="submit" disabled={busy || !newFolderName.trim()}>
            Add
          </button>
        </form>
        {error && <p className="form-error">{error}</p>}
        <button type="button" className="modal-close" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
