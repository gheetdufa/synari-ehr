import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { teamApi, teamKeys, type InviteInput, type TeamMember } from '../../../api/team';
import { useSession } from '../../../auth/StaffAuth';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Display';
import { Field, Input } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';
import { fieldErrors } from '../../clients/formUtils';
import { RoleFields } from './RoleFields';
import {
  EMPTY_INVITE,
  assignableRoles,
  inviteInput,
  supervisorOptions,
  validateInvite,
  willSeeClients,
  type InviteDraft,
} from './teamRules';

/** Invite someone to the practice by email, with their role and access. */
export function InviteMemberModal({ team, onClose }: { team: TeamMember[]; onClose: () => void }) {
  const { staff, practice } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<InviteDraft>(EMPTY_INVITE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = (patch: Partial<InviteDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const invite = useMutation({
    mutationFn: (input: InviteInput) => teamApi.invite(input),
    onSuccess: (member) => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.all });
      toast.success(`Invitation sent to ${member.email}`);
      onClose();
    },
    onError: (error) => {
      const found = fieldErrors(error);
      if (Object.keys(found).length > 0) setErrors(found);
      else setFormError(error.message);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = validateInvite(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) invite.mutate(inviteInput(draft));
  };

  const close = () => !invite.isPending && onClose();

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title="Invite a team member"
      description={`They'll get an email with a link to join ${practice.name}. The link works for 7 days.`}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={invite.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="invite-form" loading={invite.isPending}>
            Send invitation
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} noValidate className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={errors.first_name}>
            {(props) => (
              <Input {...props} autoComplete="off" value={draft.first_name} onChange={(e) => set({ first_name: e.target.value })} />
            )}
          </Field>
          <Field label="Last name" required error={errors.last_name}>
            {(props) => (
              <Input {...props} autoComplete="off" value={draft.last_name} onChange={(e) => set({ last_name: e.target.value })} />
            )}
          </Field>
          <Field label="Email" required error={errors.email} className="sm:col-span-2">
            {(props) => (
              <Input
                {...props}
                type="email"
                autoComplete="off"
                value={draft.email}
                onChange={(e) => set({ email: e.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="border-t border-sage-100 pt-4">
          <RoleFields value={draft} onChange={set} roles={assignableRoles(staff.role)} supervisors={supervisorOptions(team)} />
        </div>
        {willSeeClients(draft.role, draft.also_sees_clients) && (
          <Field label="Credentials" hint="For example LCSW, PsyD or LMFT. They can add their license and NPI later." error={errors.credentials}>
            {(props) => (
              <Input {...props} value={draft.credentials} maxLength={100} onChange={(e) => set({ credentials: e.target.value })} />
            )}
          </Field>
        )}
      </form>
    </Modal>
  );
}
