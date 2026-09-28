import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import {
  securityApi,
  securityKeys,
  type PracticeSecurity,
  type PracticeSecurityUpdate,
} from '../../../api/security';
import { useSession, useStaffAuth } from '../../../auth/StaffAuth';
import { Card, CardHeader } from '../../../ui/Card';
import { Alert, ErrorState } from '../../../ui/Display';
import { Field, Select, Switch } from '../../../ui/Form';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { changedFields } from '../../clients/formUtils';
import { SettingsForm } from '../SettingsForm';
import { useDraft } from '../useDraft';
import { idleTimeoutChoices, idleTimeoutLabel, mfaCoverageText, mfaRolloutText } from './securityText';

const TITLE = 'Practice security';
const DESCRIPTION = 'Sign-in rules for everyone on the team.';

function PracticeSecurityForm({ security }: { security: PracticeSecurity }) {
  const { staff } = useSession();
  const { setSession } = useStaffAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const source = { require_staff_mfa: security.require_staff_mfa, session_idle_minutes: security.session_idle_minutes };
  const { draft, set, dirty, discard } = useDraft(source);
  const serverPolicy = security.mfa_server_policy;

  const save = useMutation({
    mutationFn: (changes: PracticeSecurityUpdate) => securityApi.updatePractice(changes),
    onSuccess: async (updated) => {
      queryClient.setQueryData(securityKeys.practice, updated);
      toast.success('Security settings saved');
      // Your own session may now need two-factor setup, or have a new idle limit.
      await setSession();
    },
    onError: (error) => toast.error(error),
  });

  const rollout =
    serverPolicy === null && draft.require_staff_mfa && !security.require_staff_mfa
      ? mfaRolloutText(security.staff_mfa_enabled, security.staff_active, staff.mfa_enabled)
      : null;

  return (
    <SettingsForm
      title={TITLE}
      description={DESCRIPTION}
      dirty={dirty}
      saving={save.isPending}
      onSubmit={() => save.mutate(changedFields(source, draft))}
      onDiscard={discard}
    >
      <div className="space-y-3">
        <Switch
          label="Require two-factor authentication for everyone on the team"
          description={
            serverPolicy === null
              ? "Everyone signs in with a code from their phone. Anyone who hasn't set it up is asked to before they can continue."
              : 'Set by the server administrator.'
          }
          checked={serverPolicy === null ? draft.require_staff_mfa : security.mfa_required}
          disabled={serverPolicy !== null}
          onChange={(require_staff_mfa) => set({ require_staff_mfa })}
        />
        <p className="flex items-center gap-2 text-sm text-sage-600">
          <ShieldCheck className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
          {mfaCoverageText(security.staff_mfa_enabled, security.staff_active)}
        </p>
        {rollout && <Alert tone="warning">{rollout}</Alert>}
      </div>
      <Field
        label="Sign people out after"
        hint="Applies to everyone on the team, on every device. Shorter is safer on shared computers."
        className="border-t border-sage-100 pt-5 sm:max-w-sm"
      >
        {(props) => (
          <Select
            {...props}
            value={draft.session_idle_minutes}
            onChange={(event) => set({ session_idle_minutes: Number(event.target.value) })}
          >
            {idleTimeoutChoices(source.session_idle_minutes).map((minutes) => (
              <option key={minutes} value={minutes}>
                {idleTimeoutLabel(minutes)} of inactivity
              </option>
            ))}
          </Select>
        )}
      </Field>
    </SettingsForm>
  );
}

/** Practice-wide sign-in rules: required two-factor authentication and the idle sign-out limit. */
export function PracticeSecurityCard() {
  const security = useQuery({ queryKey: securityKeys.practice, queryFn: securityApi.practice });
  if (security.data) return <PracticeSecurityForm security={security.data} />;
  return (
    <Card>
      <CardHeader title={TITLE} description={DESCRIPTION} />
      {security.isError ? (
        <ErrorState error={security.error} onRetry={() => void security.refetch()} />
      ) : (
        <SectionSpinner />
      )}
    </Card>
  );
}
