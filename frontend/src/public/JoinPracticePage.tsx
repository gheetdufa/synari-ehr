import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  MAX_PASSWORD_LENGTH,
  PASSWORD_HINT,
  ROLE_LABELS,
  authKeys,
  newPasswordError,
  passwordErrorField,
  staffAuth,
  type Invitation,
  type StaffRole,
} from '../api/auth';
import { ApiError } from '../api/client';
import { useStaffAuth } from '../auth/StaffAuth';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Display';
import { Field, Input } from '../ui/Form';
import { SectionSpinner } from '../ui/Spinner';
import { AuthShell } from './AuthShell';

/** "a clinician", "an owner", "a practice manager". */
export function roleWithArticle(role: StaffRole): string {
  const label = ROLE_LABELS[role].toLowerCase();
  return `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
}

interface JoinDraft {
  first_name: string;
  last_name: string;
  password: string;
  confirm: string;
}

export function validateJoin(draft: JoinDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.first_name.trim()) errors.first_name = 'Enter your first name';
  if (!draft.last_name.trim()) errors.last_name = 'Enter your last name';
  const passwordError = newPasswordError(draft.password);
  if (passwordError) errors.password = passwordError;
  if (draft.confirm !== draft.password) errors.confirm = "Passwords don't match";
  return errors;
}

function SignInLink() {
  return (
    <p className="mt-6 text-center text-sm text-sage-600">
      Already joined?{' '}
      <Link to="/login" className="font-medium text-teal-700 hover:underline">
        Sign in
      </Link>
    </p>
  );
}

function JoinForm({ token, invitation }: { token: string; invitation: Invitation }) {
  const { acceptInvitation } = useStaffAuth();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<JoinDraft>({
    first_name: invitation.first_name,
    last_name: invitation.last_name,
    password: '',
    confirm: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const set = (patch: Partial<JoinDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateJoin(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setJoining(true);
    setError(null);
    try {
      await acceptInvitation({
        token,
        password: draft.password,
        first_name: draft.first_name.trim(),
        last_name: draft.last_name.trim(),
      });
      navigate('/portal', { replace: true });
    } catch (err) {
      if (passwordErrorField(err) === 'new') setErrors({ password: (err as Error).message });
      else setError(err instanceof Error ? err.message : 'Something went wrong');
      setJoining(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
      <p className="text-center text-sm text-sage-600">
        Confirm your name and choose a password for <span className="font-medium text-sage-900">{invitation.email}</span>.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" required error={errors.first_name}>
          {(props) => (
            <Input
              {...props}
              autoComplete="given-name"
              value={draft.first_name}
              onChange={(e) => set({ first_name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Last name" required error={errors.last_name}>
          {(props) => (
            <Input
              {...props}
              autoComplete="family-name"
              value={draft.last_name}
              onChange={(e) => set({ last_name: e.target.value })}
            />
          )}
        </Field>
      </div>
      <Field label="Password" required hint={PASSWORD_HINT} error={errors.password}>
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="new-password"
            maxLength={MAX_PASSWORD_LENGTH}
            value={draft.password}
            onChange={(e) => set({ password: e.target.value })}
          />
        )}
      </Field>
      <Field label="Confirm password" required error={errors.confirm}>
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="new-password"
            value={draft.confirm}
            onChange={(e) => set({ confirm: e.target.value })}
          />
        )}
      </Field>
      <Button type="submit" loading={joining} className="w-full">
        Join {invitation.practice_name}
      </Button>
    </form>
  );
}

/** Public page for staff invitations: greet the invitee, then set a password and sign them in. */
export default function JoinPracticePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const invitation = useQuery({
    queryKey: authKeys.invitation(token),
    queryFn: () => staffAuth.invitation(token),
    enabled: Boolean(token),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (!token) {
    return (
      <AuthShell title="Join your practice">
        <Alert tone="warning">This page needs the link from your invitation email. Open the email and use its button.</Alert>
        <SignInLink />
      </AuthShell>
    );
  }

  if (invitation.isPending) {
    return (
      <AuthShell title="Join your practice">
        <SectionSpinner />
      </AuthShell>
    );
  }

  if (invitation.isError) {
    const invalid = invitation.error instanceof ApiError && invitation.error.status >= 400 && invitation.error.status < 500;
    return (
      <AuthShell title={invalid ? 'This invitation has expired' : 'Join your practice'}>
        <Alert tone={invalid ? 'warning' : 'danger'}>
          {invalid
            ? 'This invitation link is invalid, has already been used, or has expired. Ask your practice to send you a new one.'
            : invitation.error.message}
        </Alert>
        {!invalid && (
          <Button variant="secondary" className="mt-4 w-full" onClick={() => void invitation.refetch()}>
            Try again
          </Button>
        )}
        <SignInLink />
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Join ${invitation.data.practice_name} as ${roleWithArticle(invitation.data.role)}`}>
      <JoinForm token={token} invitation={invitation.data} />
      <SignInLink />
    </AuthShell>
  );
}
