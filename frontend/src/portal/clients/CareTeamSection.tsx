import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Stethoscope } from 'lucide-react';
import { clientKeys, clientsApi, type CareTeamInput, type ClientDetail } from '../../api/clients';
import { useCan, useSession } from '../../auth/StaffAuth';
import { displayFirstName } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, Badge } from '../../ui/Display';
import { Checkbox, Field, Select } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { primaryClinician, useClientPermissions, useClinicians } from './clientPermissions';

/** The care team payload: the primary clinician plus the others (never listing the primary twice). */
export function careTeamInput(primaryId: string, memberIds: number[]): { input: CareTeamInput | null; error: string | null } {
  if (!primaryId) return { input: null, error: 'Choose a primary clinician' };
  const primary = Number(primaryId);
  return {
    input: {
      primary_clinician_id: primary,
      clinician_ids: [...new Set(memberIds)].filter((id) => id !== primary).sort((a, b) => a - b),
    },
    error: null,
  };
}

function CareTeamModal({ client, onClose }: { client: ClientDetail; onClose: () => void }) {
  const { staff } = useSession();
  const seesEveryClient = useCan('view_all_clients');
  const queryClient = useQueryClient();
  const toast = useToast();
  const clinicians = useClinicians();
  const [primaryId, setPrimaryId] = useState(String(primaryClinician(client.care_team)?.staff_id ?? ''));
  const [memberIds, setMemberIds] = useState(() =>
    client.care_team.filter((member) => !member.is_primary).map((member) => member.staff_id),
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: CareTeamInput) => clientsApi.setCareTeam(client.id, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(clientKeys.detail(client.id), updated);
      void queryClient.invalidateQueries({ queryKey: ['clients', 'list'] });
      toast.success('Care team updated');
      onClose();
    },
    onError: (failure) => setError(failure.message),
  });

  const toggle = (staffId: number, checked: boolean) =>
    setMemberIds((current) => (checked ? [...current, staffId] : current.filter((id) => id !== staffId)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { input, error: problem } = careTeamInput(primaryId, memberIds);
    setError(problem);
    if (input) save.mutate(input);
  };

  const onTeamNow = client.care_team.some((member) => member.staff_id === staff.id);
  const staysOnTeam = primaryId === String(staff.id) || memberIds.includes(staff.id);
  const others = (clinicians.data ?? []).filter((member) => String(member.id) !== primaryId);

  return (
    <Modal
      open
      onClose={() => !save.isPending && onClose()}
      title="Edit care team"
      description={`Clinicians on the care team can open ${displayFirstName(client)}'s chart.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="care-team-form" loading={save.isPending} disabled={!clinicians.data}>
            Save care team
          </Button>
        </>
      }
    >
      {clinicians.isPending && <SectionSpinner />}
      {clinicians.isError && <Alert tone="danger">Couldn&apos;t load the team. {clinicians.error.message}</Alert>}
      {clinicians.data && (
        <form id="care-team-form" onSubmit={submit} noValidate className="space-y-4">
          <Field label="Primary clinician" required error={error}>
            {(props) => (
              <Select {...props} value={primaryId} onChange={(event) => setPrimaryId(event.target.value)}>
                <option value="">Choose a clinician</option>
                {clinicians.data.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.display_name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {others.length > 0 && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-sage-800">Other clinicians</legend>
              <div className="space-y-2">
                {others.map((member) => (
                  <Checkbox
                    key={member.id}
                    label={member.display_name}
                    checked={memberIds.includes(member.id)}
                    onChange={(event) => toggle(member.id, event.target.checked)}
                  />
                ))}
              </div>
            </fieldset>
          )}
          {onTeamNow && !staysOnTeam && !seesEveryClient && (
            <Alert tone="warning">You&apos;re removing yourself, so you may no longer be able to open this chart.</Alert>
          )}
        </form>
      )}
    </Modal>
  );
}

/** The client's clinicians, primary first; the primary clinician and schedulers can change them. */
export function CareTeamSection({ client }: { client: ClientDetail }) {
  const { editCareTeam } = useClientPermissions(client);
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Care team"
        actions={
          editCareTeam && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Pencil className="h-3.5 w-3.5" />}
              onClick={() => setEditing(true)}
              aria-label="Edit care team"
            >
              Edit
            </Button>
          )
        }
      />
      <CardBody>
        {client.care_team.length === 0 ? (
          <p className="text-sm text-sage-500">No clinician is assigned to this client.</p>
        ) : (
          <ul className="space-y-2">
            {client.care_team.map((member) => (
              <li key={member.staff_id} className="flex items-center gap-2 text-sm text-sage-900">
                <Stethoscope className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
                {member.name}
                {member.is_primary && <Badge tone="primary">Primary</Badge>}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {editing && <CareTeamModal client={client} onClose={() => setEditing(false)} />}
    </Card>
  );
}
