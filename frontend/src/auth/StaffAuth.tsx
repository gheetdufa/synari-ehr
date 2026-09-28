import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { onMfaSetupRequired, onSessionExpired, tokenStore } from '../api/client';
import { staffAuth, type AcceptInvitationInput, type Capability, type RegisterInput, type Session } from '../api/auth';
import { meApi } from '../api/me';
import { queryClient } from '../lib/queryClient';
import { FullPageSpinner } from '../ui/Spinner';

const MfaEnrollmentPage = lazy(() => import('./MfaEnrollmentPage'));

type Status = 'loading' | 'signedIn' | 'signedOut';

export interface StaffAuthValue {
  status: Status;
  session: Session | null;
  /** Password step. Resolves to null when signed in, or to a token for the 2FA code step. */
  login: (email: string, password: string) => Promise<{ mfaToken: string } | null>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  /** Create a practice and sign in; resolves to the new session. */
  register: (input: RegisterInput) => Promise<Session>;
  acceptInvitation: (input: AcceptInvitationInput) => Promise<void>;
  /** Sign out this device. */
  logout: () => Promise<void>;
  /** Sign out every device, this one included. Rejects, still signed in, if the API refuses. */
  logoutEverywhere: () => Promise<void>;
  /**
   * Adopt a session returned by the API (after a profile or practice update, or a token-issuing
   * call such as a password change), or re-fetch it from /api/me when called with nothing.
   */
  setSession: (session?: Session) => Promise<void>;
}

/** Exported so tests can render signed-in screens with a fixed session (see src/test/session.tsx). */
export const StaffAuthContext = createContext<StaffAuthValue | null>(null);

/** Staff app (`/portal`) sign-in state: the signed-in person, their practice and capabilities. */
export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>(() => (tokenStore.get('staff') ? 'loading' : 'signedOut'));

  useEffect(() => {
    if (!tokenStore.get('staff')) return;
    meApi
      .session()
      .then((current) => {
        setSessionState(current);
        setStatus('signedIn');
      })
      .catch(() => {
        tokenStore.clear('staff');
        setStatus('signedOut');
      });
  }, []);

  const signedOut = useCallback(() => {
    queryClient.clear();
    setSessionState(null);
    setStatus('signedOut');
  }, []);

  useEffect(
    () =>
      onSessionExpired((realm) => {
        if (realm === 'staff') signedOut();
      }),
    [signedOut],
  );

  // The practice started requiring two-factor while this person was signed in: reload the
  // session so the setup screen appears. The refused request reports its own error.
  useEffect(
    () =>
      onMfaSetupRequired(() => {
        meApi
          .session()
          .then(setSessionState)
          .catch(() => undefined);
      }),
    [],
  );

  /** Start a fresh signed-in session (a different person may have signed in on this browser). */
  const begin = useCallback((next: Session) => {
    queryClient.clear();
    setSessionState(next);
    setStatus('signedIn');
    return next;
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await staffAuth.login(email, password);
      if (result.status === 'mfa') return { mfaToken: result.mfaToken };
      begin(result.session);
      return null;
    },
    [begin],
  );

  const completeMfa = useCallback(
    async (mfaToken: string, code: string) => {
      begin(await staffAuth.completeMfa(mfaToken, code));
    },
    [begin],
  );

  const register = useCallback(async (input: RegisterInput) => begin(await staffAuth.register(input)), [begin]);

  const acceptInvitation = useCallback(
    async (input: AcceptInvitationInput) => {
      begin(await staffAuth.acceptInvitation(input));
    },
    [begin],
  );

  const logout = useCallback(async () => {
    await staffAuth.logout().catch(() => undefined);
    signedOut();
  }, [signedOut]);

  const logoutEverywhere = useCallback(async () => {
    await staffAuth.logoutEverywhere();
    signedOut();
  }, [signedOut]);

  const setSession = useCallback(async (next?: Session) => {
    setSessionState(next ?? (await meApi.session()));
    setStatus('signedIn');
  }, []);

  const value = useMemo(
    () => ({
      status,
      session,
      login,
      completeMfa,
      register,
      acceptInvitation,
      logout,
      logoutEverywhere,
      setSession,
    }),
    [status, session, login, completeMfa, register, acceptInvitation, logout, logoutEverywhere, setSession],
  );
  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>;
}

export function useStaffAuth(): StaffAuthValue {
  const value = useContext(StaffAuthContext);
  if (!value) throw new Error('useStaffAuth must be used inside StaffAuthProvider');
  return value;
}

/** The signed-in staff member, their practice and capabilities. Only use below <RequireStaff>. */
export function useSession(): Session {
  const { session } = useStaffAuth();
  if (!session) throw new Error('useSession used outside a signed-in area');
  return session;
}

/** Whether the signed-in staff member's role grants a capability. Only use below <RequireStaff>. */
export function useCan(capability: Capability): boolean {
  return useSession().capabilities.includes(capability);
}

/**
 * Renders children for signed-in staff; otherwise sends them to /login. Someone who must set up
 * two-factor authentication first gets the setup screen instead, then the page they asked for.
 */
export function RequireStaff({ children }: { children: ReactNode }) {
  const { status, session } = useStaffAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'signedOut') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (session?.mfa_setup_required) {
    return (
      <Suspense fallback={<FullPageSpinner />}>
        <MfaEnrollmentPage />
      </Suspense>
    );
  }
  return <>{children}</>;
}
