import type { Session } from '../../api/auth';
import type { TeamMember } from '../../api/team';

/** A clinician's id, or every conversation the viewer can read. */
export type ClinicianFilter = number | 'all';

export interface ClinicianFilterOption {
  value: ClinicianFilter;
  label: string;
}

/** Clinicians start on their own conversations; staff who don't see clients start on everyone's. */
export function defaultClinicianFilter({ staff }: Session): ClinicianFilter {
  return staff.is_clinician ? staff.id : 'all';
}

/**
 * The other clinicians whose conversations the viewer can read: every active clinician for staff
 * who can open every chart, else the viewer's active supervisees.
 */
export function readableClinicians({ staff, capabilities }: Session, team: TeamMember[]): TeamMember[] {
  const seesEveryone = capabilities.includes('clinical_all');
  return team.filter(
    (member) =>
      member.id !== staff.id &&
      member.is_clinician &&
      member.status === 'active' &&
      (seesEveryone || member.supervisor_id === staff.id),
  );
}

/**
 * The inbox's clinician filter, or no options when the viewer only ever sees their own
 * conversations. Staff who can open every chart always get it; supervisors get it for their
 * supervisees. `others` are the clinicians from `readableClinicians`.
 */
export function clinicianFilterOptions(session: Session, others: TeamMember[]): ClinicianFilterOption[] {
  const { staff, capabilities } = session;
  if (others.length === 0 && !capabilities.includes('clinical_all')) return [];
  const options: ClinicianFilterOption[] = staff.is_clinician ? [{ value: staff.id, label: 'My conversations' }] : [];
  options.push({ value: 'all', label: 'All conversations' });
  const named = [...others].sort((a, b) => a.display_name.localeCompare(b.display_name));
  return [...options, ...named.map((member) => ({ value: member.id, label: member.display_name }))];
}
