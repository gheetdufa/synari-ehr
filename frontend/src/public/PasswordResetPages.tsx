import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MAX_PASSWORD_LENGTH, PASSWORD_HINT, newPasswordError, passwordErrorField, staffAuth } from '../api/auth';
import { useStaffAuth } from '../auth/StaffAuth';
import { MfaCodeForm } from '../auth/MfaCodeForm';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Display';
import { Field, Input } from '../ui/Form';
import { AuthShell } from './AuthShell';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await staffAuth.requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Reset your password">
      {sent ? (
        <Alert tone="success" title="Check your email">
          If {email} has an account, a reset link is on its way. It expires in one hour.
        </Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Email address" required>
            {(props) => (
              <Input {...props} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            )}
          </Field>
          <Button type="submit" loading={loading} className="w-full">
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm text-sage-600">
        <Link to="/login" className="font-medium text-teal-700 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { setSession, completeMfa } = useStaffAuth();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string }>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = {
      password: newPasswordError(password) ?? undefined,
      confirm: password !== confirm ? "The passwords don't match" : undefined,
    };
    setFieldErrors(found);
    setError(null);
    if (found.password || found.confirm) return;
    setLoading(true);
    try {
      const result = await staffAuth.confirmPasswordReset(token, password);
      if (result.status === 'mfa') {
        setMfaToken(result.mfaToken);
        setLoading(false);
        return;
      }
      await setSession(result.session);
      navigate('/portal', { replace: true });
    } catch (err) {
      if (passwordErrorField(err) === 'new') setFieldErrors({ password: (err as Error).message });
      else setError(err instanceof Error ? err.message : 'Something went wrong');
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title="Reset your password">
        <Alert tone="warning">This page needs the link from your reset email.</Alert>
        <Button variant="secondary" className="mt-4 w-full" onClick={() => navigate('/forgot-password')}>
          Request a new link
        </Button>
      </AuthShell>
    );
  }

  if (mfaToken) {
    return (
      <AuthShell title="Confirm it's you">
        <MfaCodeForm
          onSubmit={async (code) => {
            await completeMfa(mfaToken, code);
            navigate('/portal', { replace: true });
          }}
          onCancel={() => navigate('/login')}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={submit} noValidate className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="New password" hint={PASSWORD_HINT} error={fieldErrors.password} required>
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              maxLength={MAX_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm new password" error={fieldErrors.confirm} required>
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              maxLength={MAX_PASSWORD_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" loading={loading} className="w-full">
          Save password and sign in
        </Button>
      </form>
    </AuthShell>
  );
}
