import { useState, type FormEvent } from 'react';
import { MAX_PASSWORD_LENGTH, PASSWORD_HINT, newPasswordError, passwordErrorField, staffAuth } from '../../api/auth';
import { useCan, useSession, useStaffAuth } from '../../auth/StaffAuth';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Field, Input } from '../../ui/Form';
import { useToast } from '../../ui/Toast';
import { EmergencyAccessReviewsCard } from './security/EmergencyAccessReviewsCard';
import { PracticeSecurityCard } from './security/PracticeSecurityCard';
import { SecurityEventsCard } from './security/SecurityEventsCard';
import { SessionsCard } from './security/SessionsCard';
import { TwoFactorCard } from './TwoFactorCard';

export interface PasswordDraft {
  current: string;
  next: string;
  confirm: string;
}

export function validatePasswordChange(draft: PasswordDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.current) errors.current = 'Enter your current password';
  const nextError = newPasswordError(draft.next);
  if (nextError) errors.next = nextError;
  else if (draft.next === draft.current) errors.next = 'Choose a password different from your current one';
  if (draft.confirm !== draft.next) errors.confirm = "Passwords don't match";
  return errors;
}

const EMPTY: PasswordDraft = { current: '', next: '', confirm: '' };

function ChangePasswordCard() {
  const { setSession } = useStaffAuth();
  const toast = useToast();
  const [draft, setDraft] = useState<PasswordDraft>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<PasswordDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validatePasswordChange(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      await setSession(await staffAuth.changePassword(draft.current, draft.next));
      setDraft(EMPTY);
      toast.success('Password changed. Your other devices were signed out.');
    } catch (error) {
      const field = passwordErrorField(error);
      if (field === 'current') setErrors({ current: (error as Error).message });
      else if (field === 'new') setErrors({ next: (error as Error).message });
      else toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <CardHeader title="Change password" description="Changing your password signs you out on every other device." />
        <CardBody className="grid gap-4 sm:max-w-md">
          <Field label="Current password" required error={errors.current}>
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="current-password"
                value={draft.current}
                onChange={(e) => set({ current: e.target.value })}
              />
            )}
          </Field>
          <Field label="New password" required hint={PASSWORD_HINT} error={errors.next}>
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="new-password"
                maxLength={MAX_PASSWORD_LENGTH}
                value={draft.next}
                onChange={(e) => set({ next: e.target.value })}
              />
            )}
          </Field>
          <Field label="Confirm new password" required error={errors.confirm}>
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="new-password"
                maxLength={MAX_PASSWORD_LENGTH}
                value={draft.confirm}
                onChange={(e) => set({ confirm: e.target.value })}
              />
            )}
          </Field>
          <div>
            <Button type="submit" loading={saving}>
              Change password
            </Button>
          </div>
        </CardBody>
      </form>
    </Card>
  );
}

/**
 * Your own sign-in security (two-factor, password, signed-in devices), plus the practice's sign-in
 * rules and security events for team managers, and emergency access reviews for owners.
 */
export function SecuritySettings() {
  const { staff } = useSession();
  const managesTeam = useCan('manage_team');
  const viewsAuditLog = useCan('view_audit_log');
  return (
    <div className="space-y-6">
      <TwoFactorCard />
      <ChangePasswordCard />
      <SessionsCard />
      {managesTeam && <PracticeSecurityCard />}
      {(managesTeam || viewsAuditLog) && <SecurityEventsCard />}
      {staff.role === 'owner' && <EmergencyAccessReviewsCard />}
    </div>
  );
}
