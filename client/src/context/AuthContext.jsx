import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/account/me');
      setUser(data?.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A visitor with no identity yet (never submitted an idea) resolves to
  // `null` from the server on purpose — see the plan's guest-identity
  // write-up. Treat that the same as "guest" everywhere in the UI: both mean
  // "not a real account yet," the only distinction that changes what's shown.
  const isGuest = !user || user.isGuest;

  return (
    <AuthContext.Provider value={{ user, isGuest, isLoading, refresh, setUser }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
