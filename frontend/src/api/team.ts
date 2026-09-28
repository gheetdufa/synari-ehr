import type { ClinicianAccess, StaffRole, StaffStatus } from './auth';
import { api } from './client';

/** Someone on the practice team (pending invitations included for team managers). */
export interface TeamMember {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  display_name: string;
  status: StaffStatus;
  role: StaffRole;
  clinician_access: ClinicianAccess;
  is_clinician: boolean;
  supervisor_id: number | null;
  credentials: string;
  license_number: string;
  license_state: string;
  npi: string;
  taxonomy_code: string;
  /** Licensure modifier some payers require on this clinician's claim lines (e.g. HO, AJ). */
  claim_modifier: string;
  accepting_new_clients: boolean;
  invited_at: string | null;
  last_login_at: string | null;
  /** Whether they sign in with two-factor authentication. */
  mfa_enabled: boolean;
}

export interface InviteInput {
  email: string;
  first_name: string;
  last_name: string;
  role: StaffRole;
  clinician_access: ClinicianAccess;
  /** Owners and practice managers may also see clients; clinicians always do. */
  is_clinician: boolean;
  supervisor_id: number | null;
  credentials: string;
}

export type TeamMemberUpdate = Partial<
  Pick<
    TeamMember,
    | 'first_name'
    | 'last_name'
    | 'role'
    | 'clinician_access'
    | 'is_clinician'
    | 'supervisor_id'
    | 'credentials'
    | 'license_number'
    | 'license_state'
    | 'npi'
    | 'taxonomy_code'
    | 'claim_modifier'
    | 'accepting_new_clients'
  >
>;

/** Whether a clinician offers a service, and their own rate (null = the practice rate). */
export interface ClinicianServiceRate {
  service_id: number;
  offered: boolean;
  rate_cents: number | null;
}

/** The clinician access levels, with what each adds beyond the clinician's own clients. */
export const CLINICIAN_ACCESS_OPTIONS: { id: ClinicianAccess; label: string; description: string }[] = [
  { id: 'basic', label: 'Basic', description: 'Only their own clients: schedule, chart and messages.' },
  { id: 'billing', label: 'Billing', description: 'Also handles billing for their own clients.' },
  {
    id: 'client_list',
    label: 'Entire client list',
    description: 'Sees and schedules every client, but opens only their own charts.',
  },
  {
    id: 'practice',
    label: 'Full practice',
    description: 'Everything in the practice except managing the team.',
  },
];

/** Roles that may also see clients as a clinician (clinicians always do). */
export const ROLES_THAT_CAN_SEE_CLIENTS: readonly StaffRole[] = ['owner', 'practice_manager'];

/** The practice team: invitations, roles, supervision, deactivation and clinician rates. */
export const teamApi = {
  list: () => api<TeamMember[]>('/team'),
  invite: (input: InviteInput) => api<TeamMember>('/team/invitations', { body: input }),
  resendInvitation: (staffId: number) =>
    api<{ detail: string }>(`/team/${staffId}/invitation`, { method: 'POST' }),
  revokeInvitation: (staffId: number) => api<void>(`/team/${staffId}/invitation`, { method: 'DELETE' }),
  update: (staffId: number, changes: TeamMemberUpdate) =>
    api<TeamMember>(`/team/${staffId}`, { method: 'PATCH', body: changes }),
  deactivate: (staffId: number) => api<TeamMember>(`/team/${staffId}/deactivate`, { method: 'POST' }),
  reactivate: (staffId: number) => api<TeamMember>(`/team/${staffId}/reactivate`, { method: 'POST' }),
  /** Sign someone out of every device (not yourself; only owners may do it to owners). */
  signOutEverywhere: (staffId: number) => api<void>(`/team/${staffId}/sessions`, { method: 'DELETE' }),
  /**
   * Owners only: turn off someone's two-factor authentication (after a lost phone), sign them out
   * and email them. They set it up again when they next sign in.
   */
  resetMfa: (staffId: number) => api<TeamMember>(`/team/${staffId}/mfa/reset`, { method: 'POST' }),
  services: (staffId: number) => api<ClinicianServiceRate[]>(`/team/${staffId}/services`),
  setServices: (staffId: number, rates: ClinicianServiceRate[]) =>
    api<ClinicianServiceRate[]>(`/team/${staffId}/services`, { method: 'PUT', body: rates }),
};

export const teamKeys = {
  all: ['team'] as const,
  members: ['team', 'members'] as const,
  services: (staffId: number) => ['team', 'services', staffId] as const,
};
