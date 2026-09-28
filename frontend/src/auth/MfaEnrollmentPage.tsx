import { useNavigate } from 'react-router-dom';
import { AuthShell } from '../public/AuthShell';
import { MfaSetupForm } from './MfaSetup';
import { useStaffAuth } from './StaffAuth';

/**
 * Full-page two-factor setup for someone who must turn it on before using the app, because the
 * practice or the server requires it. Once the recovery codes are saved, `onComplete` runs; by
 * default it reloads the session, which shows the page they were opening.
 */
export default function MfaEnrollmentPage({ onComplete }: { onComplete?: () => Promise<void> }) {
  const { session, setSession, logout } = useStaffAuth();
  const navigate = useNavigate();

  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <AuthShell title="Set up two-factor authentication">
      <p className="mb-5 text-sm text-sage-700">
        Everyone at {session?.practice.name ?? 'your practice'} signs in with a code from their phone as well as a
        password, so a stolen password isn&apos;t enough to reach client records. Set it up to continue.
      </p>
      <MfaSetupForm doneLabel="Continue" onDone={onComplete ?? (() => setSession())} />
      <p className="mt-6 text-center text-sm text-sage-600">
        {session && <>Signed in as {session.staff.email} · </>}
        <button type="button" className="font-medium text-teal-700 hover:underline" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>
    </AuthShell>
  );
}
