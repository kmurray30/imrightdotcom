import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { api } from '../../api/client.js';

export function Header() {
  const { user, isGuest, refresh } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await api.post('/api/account/logout');
    await refresh();
    navigate('/');
  }

  return (
    <header className="site-header">
      <Link to="/" className="site-logo">
        imright.com
      </Link>
      <nav className="site-nav">
        <Link to="/history">History</Link>
        {!isGuest && <Link to="/bookmarks">Bookmarks</Link>}
        {!isGuest && user?.username && <Link to={`/u/${user.username}`}>{user.displayName}</Link>}
        {isGuest ? (
          <>
            <Link to="/login">Log in</Link>
            <Link to="/signup" className="site-nav-cta">
              Sign up
            </Link>
          </>
        ) : (
          <button type="button" onClick={handleLogout} className="link-button">
            Log out
          </button>
        )}
      </nav>
    </header>
  );
}
