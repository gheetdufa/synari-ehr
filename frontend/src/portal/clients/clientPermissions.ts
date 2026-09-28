import { useQuery } from '@tanstack/react-query';
import type { Capability, Session } from '../../api/auth';
import type { CareTeamMember, ClientDetail } from '../../api/clients';
import { teamApi, teamKeys, type TeamMember } from '../../api/team';
import { useSession } from '../../auth/StaffAuth';

const has = (session: Session, capability: Capability) => session.capabilities.includes(capability);

/** Clinicians add clients to their own caseload; roles that manage every calendar add anyone's. */
export function canAddClients(session: Session): boolean {
  return session.staff.is_clinician || has(session, 'schedule_all');
}

/** Whether the person adding a client picks its primary clinician (otherwise it's themselves). */
export function choosesPrimaryClinician(session: Session): boolean {
  return has(session, 'schedule_all');
}

/** Whether this person would handle billing for a client whose primary clinician is `primaryId`. */
export function billsClientsOf(session: Session, primaryId: number | null): boolean {
  return has(session, 'billing_all') || (has(session, 'billing_own') && primaryId === session.staff.id);
}

export function primaryClinician(careTeam: CareTeamMember[]): CareTeamMember | undefined {
  return careTeam.find((member) => member.is_primary);
}

/** What the signed-in staff member may do on a client's chart (the API enforces the same rules). */
export interface ClientPermissions {
  /** Notes, internal notes, diagnoses, documents, messages and the record export. */
  clinical: boolean;
  /** Billing details, insurance, invoices and payments. */
  billing: boolean;
  /** Demographics, contacts, status and portal settings. */
  editProfile: boolean;
  /** Choose the clinicians and primary clinician. */
  editCareTeam: boolean;
  /** Book appointments (with themselves as a clinician, or on any calendar). */
  schedule: boolean;
  /** See who viewed or changed the record: staff who review the audit log, and the primary clinician. */
  accessHistory: boolean;
}

export function clientPermissions(session: Session, client: ClientDetail): ClientPermissions {
  const managesCalendars = has(session, 'schedule_all');
  const managesPractice = has(session, 'manage_practice');
  const isPrimary = primaryClinician(client.care_team)?.staff_id === session.staff.id;
  return {
    clinical: client.access.clinical,
    billing: client.access.billing,
    editProfile: client.access.clinical || managesCalendars || managesPractice,
    editCareTeam: isPrimary || managesCalendars || managesPractice,
    schedule: session.staff.is_clinician || managesCalendars,
    accessHistory: isPrimary || has(session, 'view_audit_log'),
  };
}

export function useClientPermissions(client: ClientDetail): ClientPermissions {
  return clientPermissions(useSession(), client);
}

/** Active team members who see clients, for choosing a client's clinicians. */
export function activeClinicians(team: TeamMember[]): TeamMember[] {
  return team.filter((member) => member.is_clinician && member.status === 'active');
}

export function useClinicians(enabled = true) {
  return useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list, select: activeClinicians, enabled });
}
