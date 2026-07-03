import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { setAccessToken } from '../api/client';
import type { AuthResponse } from '../api/auth';

type Tokens = {
  accessToken: string;
  refreshToken: string;
};

type AuthContextValue = {
  tokens: Tokens | null;
  user: AuthResponse['user'] | null;
  setSession: (session: AuthResponse) => void;
  logout: () => void;
};

const STORAGE_KEY = 'paybridge.auth';
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setStoredSession] = useState<AuthResponse | null>(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthResponse) : null;
  });

  useEffect(() => {
    setAccessToken(session?.accessToken);
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      tokens: session
        ? {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken
          }
        : null,
      user: session?.user ?? null,
      setSession(nextSession) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
        setStoredSession(nextSession);
      },
      logout() {
        window.localStorage.removeItem(STORAGE_KEY);
        setStoredSession(null);
      }
    }),
    [session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
