'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { login as apiLogin, logout as apiLogout, me as apiMe } from '../api/endpoints/auth';
import { isApiError } from '../api/errors';

import type { MeUser } from '../api/types';
import type { ReactNode } from 'react';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  user: MeUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<MeUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  const refresh = useCallback(async () => {
    try {
      const fresh = await apiMe();
      setUser(fresh);
      setStatus('authenticated');
    } catch (err) {
      // UNAUTHORIZED here is the expected, silent outcome for an
      // anonymous visitor -- this is the one call site in the whole app
      // that must NOT toast a 401.
      if (isApiError(err) && err.code === 'UNAUTHORIZED') {
        setUser(null);
        setStatus('anonymous');
        return;
      }
      // Any other error (network, 503) also resolves to "can't confirm
      // you're logged in" from the UI's point of view -- fail safe to
      // anonymous rather than leave `status` stuck on 'loading' forever.
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    // The login response already returns {user}, and both cookies are
    // set by this same call -- no second /me round trip needed.
    const loggedInUser = await apiLogin(email, password);
    setUser({ ...loggedInUser, emailVerifiedAt: null });
    setStatus('authenticated');
    // emailVerifiedAt isn't in the login response; refresh once in the
    // background to fill it in without blocking the redirect that
    // follows a successful login.
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus('anonymous');
  }, []);

  return (
    <AuthContext.Provider value={{ user, status, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used within <AuthProvider>.');
  return ctx;
}
