import { ROLE_LABELS, type ClinicianAccess, type StaffRole } from '../../../api/auth';
import { CLINICIAN_ACCESS_OPTIONS, type TeamMember } from '../../../api/team';
import { Field, Select, Switch } from '../../../ui/Form';
import { RadioCards } from '../RadioCards';
import { ROLE_DESCRIPTIONS, canSeeClientsOptionally, willSeeClients } from './teamRules';

export interface RoleValue {
  role: StaffRole;
  clinician_access: ClinicianAccess;
  also_sees_clients: boolean;
  supervisor_id: string;
}

/**
 * Role, clinician access level, "also sees clients" and supervisor, shared by the invite and edit
 * dialogs. With `locked`, the role fields are read-only (nobody can change their own role).
 */
export function RoleFields({
  value,
  onChange,
  roles,
  supervisors,
  locked = false,
}: {
  value: RoleValue;
  onChange: (patch: Partial<RoleValue>) => void;
  roles: StaffRole[];
  supervisors: TeamMember[];
  locked?: boolean;
}) {
  const seesClients = willSeeClients(value.role, value.also_sees_clients);
  return (
    <div className="space-y-4">
      <fieldset disabled={locked} className="min-w-0 space-y-4">
        <Field
          label="Role"
          hint={locked ? "You can't change your own role." : ROLE_DESCRIPTIONS[value.role]}
        >
          {(props) => (
            <Select {...props} value={value.role} onChange={(event) => onChange({ role: event.target.value as StaffRole })}>
              {roles.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {value.role === 'clinician' && (
          <RadioCards
            legend="Access level"
            hint="Every clinician sees the clients on their own care team. This adds:"
            options={CLINICIAN_ACCESS_OPTIONS}
            value={value.clinician_access}
            onChange={(clinician_access) => onChange({ clinician_access })}
          />
        )}
        {canSeeClientsOptionally(value.role) && (
          <Switch
            label="Also sees clients"
            description="Gives them a calendar, availability and their own clients' charts as a clinician."
            checked={value.also_sees_clients}
            onChange={(also_sees_clients) => onChange({ also_sees_clients })}
          />
        )}
      </fieldset>
      {seesClients && (
        <Field label="Supervisor" hint="Supervisors can open their supervisees' clients' charts.">
          {(props) => (
            <Select
              {...props}
              value={value.supervisor_id}
              onChange={(event) => onChange({ supervisor_id: event.target.value })}
            >
              <option value="">No supervisor</option>
              {supervisors.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.display_name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </div>
  );
}
