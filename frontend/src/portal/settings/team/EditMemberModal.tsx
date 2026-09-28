import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { teamApi, teamKeys, type TeamMember, type TeamMemberUpdate } from '../../../api/team';
import { useSession, useStaffAuth } from '../../../auth/StaffAuth';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Display';
import { Field, Input, Switch } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';
import { fieldErrors } from '../../clients/formUtils';
import { RoleFields } from './RoleFields';
import {
  assignableRoles,
  memberDraft,
  memberUpdate,
  supervisorOptions,
  validateMember,
  willSeeClients,
  type MemberDraft,
} from './teamRules';

type TextKey = 'credentials' | 'license_number' | 'license_state' | 'npi' | 'taxonomy_code' | 'claim_modifier';

/** Change someone's role, access, supervisor and professional details. */
export function EditMemberModal({ member, team, onClose }: { member: TeamMember; team: TeamMember[]; onClose: () => void }) {
  const { staff } = useSession();
  const { setSession } = useStaffAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<MemberDraft>(() => memberDraft(member));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = (patch: Partial<MemberDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const isSelf = member.id === staff.id;

  const save = useMutation({
    mutationFn: (changes: TeamMemberUpdate) => teamApi.update(member.id, changes),
    onSuccess: async (updated) => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.all });
      if (isSelf) await setSession();
      toast.success(`${updated.first_name} ${updated.last_name} updated`);
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
    const found = validateMember(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const changes = memberUpdate(member, draft);
    if (Object.keys(changes).length === 0) onClose();
    else save.mutate(changes);
  };

  const text = (
    key: TextKey,
    label: string,
    options: { hint?: string; inputMode?: 'numeric'; uppercase?: boolean; maxLength?: number } = {},
  ) => (
    <Field label={label} hint={options.hint} error={errors[key]}>
      {(props) => (
        <Input
          {...props}
          inputMode={options.inputMode}
          maxLength={options.maxLength}
          value={draft[key]}
          onChange={(event) => set({ [key]: options.uppercase ? event.target.value.toUpperCase() : event.target.value })}
        />
      )}
    </Field>
  );

  const close = () => !save.isPending && onClose();
  const seesClients = willSeeClients(draft.role, draft.also_sees_clients);

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={`Edit ${member.first_name} ${member.last_name}`}
      description={member.email}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="member-form" loading={save.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="member-form" onSubmit={submit} noValidate className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <RoleFields
          value={draft}
          onChange={set}
          roles={assignableRoles(staff.role)}
          supervisors={supervisorOptions(team, member.id)}
          locked={isSelf}
        />
        {seesClients && (
          <>
            <fieldset className="border-t border-sage-100 pt-4">
              <legend className="mb-3 text-sm font-semibold text-sage-900">Professional details</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {text('credentials', 'Credentials', { hint: 'For example LCSW, PsyD or LMFT' })}
                {text('license_number', 'License number')}
                {text('license_state', 'License state')}
                {text('npi', 'Individual NPI', { inputMode: 'numeric' })}
                {text('taxonomy_code', 'Taxonomy code', { uppercase: true })}
                {text('claim_modifier', 'Claim modifier', {
                  hint: 'Licensure modifier some payers want on their claim lines, like HO or AJ',
                  uppercase: true,
                  maxLength: 2,
                })}
              </div>
            </fieldset>
            <Switch
              label="Accepting new clients"
              description="Whether new clients can be booked with them, including from the booking page."
              checked={draft.accepting_new_clients}
              onChange={(accepting_new_clients) => set({ accepting_new_clients })}
            />
          </>
        )}
      </form>
    </Modal>
  );
}
