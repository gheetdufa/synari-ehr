import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { onSessionExpired, tokenStore } from '../api/client';
import { portalAuth, type PortalClient } from '../api/auth';
import { queryClient } from '../lib/queryClient';
import { FullPageSpinner } from '../ui/Spinner';

type Status = 'loading' | 'signedIn' | 'signedOut';

interface ClientAuthValue {
  status: Status;
  client: PortalClient | null;
  /** Exchange a one-time sign-in token from an email link. */
  signInWithToken: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const ClientAuthContext = createContext<ClientAuthValue | null>(null);

export function ClientAuthProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<PortalClient | null>(null);
  const [status, setStatus] = useState<Status>(() => (tokenStore.get('client') ? 'loading' : 'signedOut'));

  useEffect(() => {
    if (!tokenStore.get('client')) return;
    portalAuth
      .me()
      .then((me) => {
        setClient(me);
        setStatus('signedIn');
      })
      .catch(() => {
        tokenStore.clear('client');
        setStatus('signedOut');
      });
  }, []);

  useEffect(
    () =>
      onSessionExpired((realm) => {
        if (realm !== 'client') return;
        setClient(null);
        setStatus('signedOut');
      }),
    [],
  );

  const signInWithToken = useCallback(async (token: string) => {
    const me = await portalAuth.verify(token);
    queryClient.removeQueries({ queryKey: ['portal'] });
    setClient(me);
    setStatus('signedIn');
  }, []);

  const logout = useCallback(async () => {
    await portalAuth.logout().catch(() => undefined);
    queryClient.removeQueries({ queryKey: ['portal'] });
    setClient(null);
    setStatus('signedOut');
  }, []);

  const value = useMemo(
    () => ({ status, client, signInWithToken, logout }),
    [status, client, signInWithToken, logout],
  );
  return <ClientAuthContext.Provider value={value}>{children}</ClientAuthContext.Provider>;
}

export function useClientAuth(): ClientAuthValue {
  const value = useContext(ClientAuthContext);
  if (!value) throw new Error('useClientAuth must be used inside ClientAuthProvider');
  return value;
}

/** The signed-in portal client. Only use below <RequireClient>. */
export function usePortalClient(): PortalClient {
  const { client } = useClientAuth();
  if (!client) throw new Error('usePortalClient used outside a signed-in area');
  return client;
}

/** Renders children for signed-in clients; otherwise sends them to the portal sign-in page. */
export function RequireClient({ children }: { children: ReactNode }) {
  const { status } = useClientAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'signedOut') {
    return <Navigate to="/client/sign-in" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}
