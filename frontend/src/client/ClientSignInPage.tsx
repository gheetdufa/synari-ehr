import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { portalAuth } from '../api/auth';
import { useClientAuth } from '../auth/ClientAuth';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Alert } from '../ui/Display';
import { Field, Input } from '../ui/Form';
import { FullPageSpinner } from '../ui/Spinner';

function safeNextPath(next: string | null): string {
  // Only portal paths; `//` and backslashes could make the browser leave the site.
  return next && next.startsWith('/client') && !next.startsWith('//') && !next.includes('\\') ? next : '/client';
}

/**
 * Client sign-in: request a one-time link by email, or (arriving from that link with ?token=)
 * exchange it for a session. The token is removed from the URL right away.
 */
export default function ClientSignInPage() {
  const [params, setParams] = useSearchParams();
  const { status, signInWithToken } = useClientAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const token = params.get('token');
  const next = safeNextPath(params.get('next'));
  const [linkError, setLinkError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    if (!token || exchanged.current) return;
    exchanged.current = true;
    setParams({}, { replace: true });
    signInWithToken(token)
      .then(() => navigate(next, { replace: true }))
      .catch((error: Error) => setLinkError(error.message));
  }, [token, next, navigate, setParams, signInWithToken]);

  if (token && !linkError) return <FullPageSpinner />;
  if (status === 'signedIn' && !token) return <Navigate to={next} replace />;
  return (
    <div className="flex min-h-screen items-center justify-center bg-sage-50 px-4 py-12">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-center text-2xl font-semibold text-sage-900">Client portal</h1>
        <p className="mb-2 text-center text-sm text-sage-600">
          Sign in with the email address your practice has on file. We&apos;ll email you a secure one-time link.
        </p>
        <p className="mb-6 text-center text-sm text-sage-600">
          Parents and guardians: use your own email address. You&apos;ll get a link for each person whose portal you
          can open.
        </p>
        {(location.state as { reason?: string } | null)?.reason === 'idle' && !linkError && (
          <div className="mb-4">
            <Alert tone="info">You were signed out after a period of inactivity to protect your privacy.</Alert>
          </div>
        )}
        {linkError && (
          <div className="mb-4">
            <Alert tone="warning" title="That sign-in link didn't work">
              {linkError} Request a new link below.
            </Alert>
          </div>
        )}
        <RequestLinkForm />
      </div>
    </div>
  );
}

function RequestLinkForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      await portalAuth.requestLink(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Card className="p-6 text-center">
        <Mail className="mx-auto mb-3 h-10 w-10 text-primary-600" />
        <h2 className="text-lg font-semibold text-sage-900">Check your email</h2>
        <p className="mt-2 text-sm text-sage-600">
          If {email} is registered with a practice, a sign-in link is on its way. It works once and expires in an hour.
          If you can open more than one portal, you&apos;ll get a link for each.
        </p>
        <Button variant="ghost" className="mt-4" onClick={() => setSent(false)}>
          Use a different email
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Email address" required>
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" loading={sending} className="w-full">
          Email me a sign-in link
        </Button>
      </form>
    </Card>
  );
}
