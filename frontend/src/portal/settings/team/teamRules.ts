import { ROLE_LABELS, type ClinicianAccess, type StaffRole, type StaffStatus } from '../../../api/auth';
import type { Service } from '../../../api/practice';
import {
  CLINICIAN_ACCESS_OPTIONS,
  ROLES_THAT_CAN_SEE_CLIENTS,
  type ClinicianServiceRate,
  type InviteInput,
  type TeamMember,
  type TeamMemberUpdate,
} from '../../../api/team';
import { formatMoney, parseMoneyToCents } from '../../../lib/format';
import { centsToInput, changedFields, isValidEmail } from '../../clients/formUtils';
import { isValidNpi, isValidTaxonomy } from '../settingsHelpers';

/** What each role can do, in one line (mirrors the API's `permissions.py`). */
export const ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  owner: 'Everything, including the team, billing and practice settings.',
  clinician: 'Sees their own clients, plus more depending on their access level.',
  practice_manager: 'Runs the team, settings, every calendar and billing. No clinical records.',
  biller: 'All billing, insurance and reports, and client profiles. No clinical records.',
  scheduler: 'Every calendar and client profile. No clinical records or billing.',
};

const ROLE_ORDER: StaffRole[] = ['owner', 'clinician', 'practice_manager', 'biller', 'scheduler'];

/** Roles the signed-in person may give someone: only owners can make (or manage) owners. */
export function assignableRoles(currentRole: StaffRole): StaffRole[] {
  return currentRole === 'owner' ? ROLE_ORDER : ROLE_ORDER.filter((role) => role !== 'owner');
}

export function canSeeClientsOptionally(role: StaffRole): boolean {
  return ROLES_THAT_CAN_SEE_CLIENTS.includes(role);
}

/** Whether someone with this role (and "also sees clients" choice) will see clients. */
export function willSeeClients(role: StaffRole, alsoSeesClients: boolean): boolean {
  return role === 'clinician' || (alsoSeesClients && canSeeClientsOptionally(role));
}

export const STATUS_LABELS: Record<StaffStatus, string> = {
  invited: 'Invited',
  active: 'Active',
  deactivated: 'Deactivated',
};

export const STATUS_TONES = { invited: 'warning', active: 'success', deactivated: 'neutral' } as const;

/** "Clinician · Full practice", "Owner · Sees clients" or just "Biller". */
export function roleSummary(member: Pick<TeamMember, 'role' | 'clinician_access' | 'is_clinician'>): string {
  const role = ROLE_LABELS[member.role];
  if (member.role === 'clinician') {
    const access = CLINICIAN_ACCESS_OPTIONS.find((option) => option.id === member.clinician_access);
    return access ? `${role} · ${access.label}` : role;
  }
  return member.is_clinician ? `${role} · Sees clients` : role;
}

/** Active clinicians who can supervise, excluding the person being edited. */
export function supervisorOptions(team: TeamMember[], excludeId?: number): TeamMember[] {
  return team.filter((member) => member.status === 'active' && member.is_clinician && member.id !== excludeId);
}

/** Supervisor ids travel through <select> as strings; '' means none. */
function supervisorFrom(value: string): number | null {
  return value ? Number(value) : null;
}

export interface InviteDraft {
  email: string;
  first_name: string;
  last_name: string;
  role: StaffRole;
  clinician_access: ClinicianAccess;
  also_sees_clients: boolean;
  supervisor_id: string;
  credentials: string;
}

export const EMPTY_INVITE: InviteDraft = {
  email: '',
  first_name: '',
  last_name: '',
  role: 'clinician',
  clinician_access: 'basic',
  also_sees_clients: false,
  supervisor_id: '',
  credentials: '',
};

export function validateInvite(draft: InviteDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.email.trim()) errors.email = 'Enter their email address';
  else if (!isValidEmail(draft.email)) errors.email = 'Enter a valid email address, like name@example.com';
  if (!draft.first_name.trim()) errors.first_name = 'Enter their first name';
  if (!draft.last_name.trim()) errors.last_name = 'Enter their last name';
  return errors;
}

/** The API payload for an invitation. Clinical fields are dropped for people who won't see clients. */
export function inviteInput(draft: InviteDraft): InviteInput {
  const seesClients = willSeeClients(draft.role, draft.also_sees_clients);
  return {
    email: draft.email.trim(),
    first_name: draft.first_name.trim(),
    last_name: draft.last_name.trim(),
    role: draft.role,
    clinician_access: draft.role === 'clinician' ? draft.clinician_access : 'basic',
    is_clinician: seesClients,
    supervisor_id: seesClients ? supervisorFrom(draft.supervisor_id) : null,
    credentials: seesClients ? draft.credentials.trim() : '',
  };
}

export interface MemberDraft {
  role: StaffRole;
  clinician_access: ClinicianAccess;
  also_sees_clients: boolean;
  supervisor_id: string;
  credentials: string;
  license_number: string;
  license_state: string;
  npi: string;
  taxonomy_code: string;
  claim_modifier: string;
  accepting_new_clients: boolean;
}

export function memberDraft(member: TeamMember): MemberDraft {
  return {
    role: member.role,
    clinician_access: member.clinician_access,
    also_sees_clients: member.is_clinician,
    supervisor_id: member.supervisor_id === null ? '' : String(member.supervisor_id),
    credentials: member.credentials,
    license_number: member.license_number,
    license_state: member.license_state,
    npi: member.npi,
    taxonomy_code: member.taxonomy_code,
    claim_modifier: member.claim_modifier,
    accepting_new_clients: member.accepting_new_clients,
  };
}

export function validateMember(draft: MemberDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.npi.trim() && !isValidNpi(draft.npi.trim())) errors.npi = 'An NPI is exactly 10 digits';
  if (draft.taxonomy_code.trim() && !isValidTaxonomy(draft.taxonomy_code.trim())) {
    errors.taxonomy_code = 'A taxonomy code is 10 characters, like 101YM0800X';
  }
  if (!/^([A-Z0-9]{2})?$/.test(draft.claim_modifier.trim())) errors.claim_modifier = 'A modifier is 2 letters or digits, like HO';
  return errors;
}

/** Only the fields that changed, so role fields aren't sent when someone edits themselves. */
export function memberUpdate(member: TeamMember, draft: MemberDraft): TeamMemberUpdate {
  const seesClients = willSeeClients(draft.role, draft.also_sees_clients);
  return changedFields(member, {
    role: draft.role,
    clinician_access: draft.role === 'clinician' ? draft.clinician_access : member.clinician_access,
    is_clinician: seesClients,
    supervisor_id: seesClients ? supervisorFrom(draft.supervisor_id) : null,
    credentials: draft.credentials.trim(),
    license_number: draft.license_number.trim(),
    license_state: draft.license_state.trim(),
    npi: draft.npi.trim(),
    taxonomy_code: draft.taxonomy_code.trim(),
    claim_modifier: draft.claim_modifier.trim(),
    accepting_new_clients: draft.accepting_new_clients,
  });
}

/** One editable row of a clinician's services: offered, and a rate override ('' = practice rate). */
export interface RateRow {
  service: Service;
  offered: boolean;
  rate: string;
}

export function rateRows(services: Service[], rates: ClinicianServiceRate[]): RateRow[] {
  const byService = new Map(rates.map((rate) => [rate.service_id, rate]));
  return services.map((service) => {
    const rate = byService.get(service.id);
    return { service, offered: rate?.offered ?? true, rate: centsToInput(rate?.rate_cents ?? null) };
  });
}

/** Validate rate overrides and build the PUT payload (every service, in order). */
export function ratesInput(rows: RateRow[]): { rates: ClinicianServiceRate[]; errors: Record<number, string> } {
  const errors: Record<number, string> = {};
  const rates = rows.map(({ service, offered, rate }) => {
    const cents = rate.trim() ? parseMoneyToCents(rate) : null;
    if (rate.trim() && cents === null) errors[service.id] = 'Enter an amount like 150 or 150.00';
    return { service_id: service.id, offered, rate_cents: cents };
  });
  return { rates, errors };
}

export function practiceRateHint(service: Service): string {
  return `Practice rate ${formatMoney(service.rate_cents)}`;
}
