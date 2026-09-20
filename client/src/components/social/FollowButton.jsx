import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useGuestGate } from '../../context/GuestGateContext.jsx';

export function FollowButton({ userId, initialFollowing = false }) {
  const { isGuest, user } = useAuth();
  const { promptSignup } = useGuestGate();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);

  if (user?.id === userId) return null;

  async function toggle() {
    if (isGuest) {
      promptSignup('follow people');
      return;
    }
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
