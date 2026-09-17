import { Link } from 'react-router-dom';

/** Wraps a guest-gated action: shows the real control for account holders,
 * a "sign up to do this" prompt for guests — never a raw 403. */
export function GuestPrompt({ message = 'Sign up to do this' }) {
  return (
    <span className="guest-prompt">
      <Link to="/signup">{message}</Link>
    </span>
  );
}
