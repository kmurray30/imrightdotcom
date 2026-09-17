import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { GuestPrompt } from '../auth/GuestPrompt.jsx';

export function FollowButton({ userId, initialFollowing = false }) {
  const { isGuest, user } = useAuth();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);

  if (isGuest) return <GuestPrompt message="Sign up to follow" />;
  if (user?.id === userId) return null;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !following;
    setFollowing(next);
    try {
      if (next) {
        await api.post(`/api/users/${userId}/follow`);
      } else {
        await api.delete(`/api/users/${userId}/follow`);
      }
    } catch {
      setFollowing(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={`follow-button ${following ? 'is-following' : ''}`} onClick={toggle} disabled={busy}>
      {following ? 'Following' : 'Follow'}
    </button>
  );
}
