import { useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { api } from '../../api/client.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Logged-in users (real accounts) skip the email field entirely — their
 * account email is used server-side. Guests (and anyone with no identity
 * yet) have no account email to fall back on, so they type one. */
export function FeedbackModal({ onClose }) {
  const { user, isGuest } = useAuth();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  const emailValid = !isGuest || EMAIL_PATTERN.test(email.trim());
  const canSubmit = message.trim().length > 0 && emailValid && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/feedback', isGuest ? { email: email.trim(), message: message.trim() } : { message: message.trim() });
      setSent(true);
    } catch {
      setError('Could not send feedback. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal feedback-modal" onClick={(e) => e.stopPropagation()}>
        {sent ? (
          <>
            <h3>Thanks!</h3>
            <p>Your feedback has been sent.</p>
            <div className="delete-modal-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Give feedback</h3>
            {isGuest ? (
              <label className="delete-confirm-label">
                Your email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </label>
            ) : (
              <p className="auth-subtitle">We'll follow up at {user.email} if needed.</p>
            )}
            <label className="delete-confirm-label">
              What's on your mind?
              <textarea
                rows={5}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={5000}
                placeholder="Bugs, ideas, complaints — anything."
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="delete-modal-actions">
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" onClick={handleSubmit} disabled={!canSubmit}>
                {busy ? 'Sending…' : 'Send feedback'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
