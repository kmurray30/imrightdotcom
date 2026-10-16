import { createContext, useContext, useState } from 'react';
import { Link } from 'react-router-dom';

const GuestGateContext = createContext(null);

/**
 * Real action buttons (Like, Save, Follow, Post a comment, the visibility
 * toggle) are always visible and clickable now, even for guests — a real
 * report called having "Sign up to ___" repeated three separate times
 * across one article page "crazy". Pressing one as a guest calls
 * promptSignup() instead of performing the action, which pops this one
 * shared modal rather than hiding the control behind inline prompt text.
 */
export function GuestGateProvider({ children }) {
  const [message, setMessage] = useState(null);

  function promptSignup(actionText) {
    setMessage(actionText ? `Sign up to ${actionText}.` : 'Sign up to do that.');
  }

  function close() {
    setMessage(null);
  }

  return (
    <GuestGateContext.Provider value={{ promptSignup }}>
      {children}
      {message && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create a free account</h3>
            <p>{message}</p>
            <div className="guest-gate-actions">
              <Link to="/signup" className="button-primary" onClick={close}>
                Sign up
              </Link>
              <button type="button" onClick={close}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </GuestGateContext.Provider>
  );
}

export function useGuestGate() {
  const ctx = useContext(GuestGateContext);
  if (!ctx) throw new Error('useGuestGate must be used within GuestGateProvider');
  return ctx;
}
