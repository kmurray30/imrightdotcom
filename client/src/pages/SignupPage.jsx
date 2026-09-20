import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

export function SignupPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/account/signup', { username, email, password, displayName });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(describeError(err.code));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <h1>Sign up</h1>
      <p className="auth-subtitle">
        Any articles you've already generated on this browser will show up in your history right away.
      </p>
      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            minLength={3}
            maxLength={20}
            pattern="[a-zA-Z0-9_\-]+"
            title="3-20 characters: letters, numbers, underscores, hyphens"
            required
          />
        </label>
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Anonymous" />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? 'Signing up…' : 'Sign up'}
        </button>
      </form>
    </div>
  );
}

function describeError(code) {
  switch (code) {
    case 'username_taken':
      return 'That username is already taken.';
    case 'email_taken':
      return 'That email is already registered.';
    case 'invalid_username':
      return 'Username must be 3-20 characters (letters, numbers, _ or -).';
    case 'invalid_email':
      return 'Please enter a valid email address.';
    case 'weak_password':
      return 'Password must be at least 8 characters.';
    case 'already_logged_in':
      return "You're already logged in.";
    default:
      return 'Something went wrong. Please try again.';
  }
}
