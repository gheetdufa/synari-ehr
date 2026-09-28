import type { TeamMember } from '../api/team';

/** An active clinician on the team for tests, with any fields overridden. */
export function teamMember(id: number, changes: Partial<TeamMember> = {}): TeamMember {
  return {
    id,
    email: `staff${id}@example.com`,
    first_name: 'Staff',
    last_name: String(id),
    display_name: `Staff ${id}`,
    status: 'active',
    role: 'clinician',
    clinician_access: 'basic',
    is_clinician: true,
    supervisor_id: null,
    credentials: '',
    license_number: '',
    license_state: '',
    npi: '',
    taxonomy_code: '',
    claim_modifier: '',
    accepting_new_clients: true,
    invited_at: null,
    last_login_at: null,
    mfa_enabled: false,
    ...changes,
  };
}
