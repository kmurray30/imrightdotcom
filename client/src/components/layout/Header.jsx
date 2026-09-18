import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { api } from '../../api/client.js';

/** All nav options live behind one dropdown — previously a flat row of
 * links that, with no responsive handling at all, overlapped and ran off
 * the edge of the screen on a phone-width viewport (confirmed via a real
 * mobile screenshot: "Log out" was cut off past the right edge, unreachable). */
export function Header() {
  const { user, isGuest, refresh } = useAuth();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  async function handleLogout() {
    setIsOpen(false);
    await api.post('/api/account/logout');
    await refresh();
    navigate('/');
  }

  return (
    <header className="site-header">
      <Link to="/" className="site-logo">
        imright.com
      </Link>
      <div className="site-nav-menu" ref={menuRef}>
        <button
          type="button"
          className="site-nav-toggle"
          onClick={() => setIsOpen((open) => !open)}
          aria-haspopup="true"
          aria-expanded={isOpen}
        >
          Menu ☰
        </button>
        {isOpen && (
          <nav className="site-nav-dropdown">
            <Link to="/history" onClick={() => setIsOpen(false)}>
              History
            </Link>
            {!isGuest && (
              <Link to="/bookmarks" onClick={() => setIsOpen(false)}>
                Bookmarks
              </Link>
            )}
            {!isGuest && user?.username && (
              <Link to={`/u/${user.username}`} onClick={() => setIsOpen(false)}>
                {user.displayName}
              </Link>
            )}
            {isGuest ? (
              <>
                <Link to="/login" onClick={() => setIsOpen(false)}>
                  Log in
                </Link>
                <Link to="/signup" onClick={() => setIsOpen(false)}>
                  Sign up
                </Link>
              </>
            ) : (
              <button type="button" onClick={handleLogout} className="link-button">
                Log out
              </button>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}
