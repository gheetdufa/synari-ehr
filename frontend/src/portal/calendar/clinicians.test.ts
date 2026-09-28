import { afterEach, describe, expect, it } from 'vitest';
import type { TeamMember } from '../../api/team';
import { testSession } from '../../test/session';
import {
  CLINICIAN_COLORS,
  calendarClinicians,
  canManageCalendar,
  canSchedule,
  effectiveSelection,
  readSelection,
  saveSelection,
  selectedClinicians,
} from './clinicians';

function member(id: number, name: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id,
    email: `${id}@example.com`,
    first_name: name,
    last_name: '',
    display_name: name,
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
    ...overrides,
  };
}

const TEAM = [
  member(7, 'Ana'),
  member(1, 'Dana', { role: 'owner' }),
  member(3, 'Sky', { role: 'scheduler', is_clinician: false }),
  member(4, 'Former', { status: 'deactivated' }),
  member(2, 'Jordan'),
];

const OWNER = testSession();
const SCHEDULER = testSession({ staff: { id: 3, role: 'scheduler', is_clinician: false }, capabilities: ['schedule_all'] });
const CLINICIAN = testSession({ staff: { id: 2, role: 'clinician' }, capabilities: [] });
const BILLER = testSession({ staff: { id: 9, role: 'biller', is_clinician: false }, capabilities: ['billing_all'] });

afterEach(() => localStorage.clear());

describe('calendar clinicians', () => {
  it('lists active clinicians in team order, colored by when they joined', () => {
    const clinicians = calendarClinicians(TEAM);
    expect(clinicians.map((clinician) => clinician.name)).toEqual(['Ana', 'Dana', 'Jordan']);
    expect(clinicians.map((clinician) => clinician.color)).toEqual([CLINICIAN_COLORS[2], CLINICIAN_COLORS[0], CLINICIAN_COLORS[1]]);
  });

  it('knows whose calendars each role manages', () => {
    expect(canManageCalendar(CLINICIAN, 2)).toBe(true);
    expect(canManageCalendar(CLINICIAN, 1)).toBe(false);
    expect(canManageCalendar(SCHEDULER, 1)).toBe(true);
    expect(canSchedule(BILLER)).toBe(false);
    expect(canSchedule(SCHEDULER)).toBe(true);
  });
});

describe('calendar filter', () => {
  const clinicians = calendarClinicians(TEAM);

  it('starts with your own calendar as a clinician and everyone otherwise', () => {
    expect(readSelection(CLINICIAN)).toEqual([2]);
    expect(readSelection(SCHEDULER)).toBe('all');
  });

  it('remembers the last choice per person on this browser', () => {
    saveSelection(2, [1, 7]);
    expect(readSelection(CLINICIAN)).toEqual([1, 7]);
    expect(readSelection(OWNER)).toEqual([1]);
    localStorage.setItem('synari.calendar.clinicians.2', 'not json');
    expect(readSelection(CLINICIAN)).toEqual([2]);
  });

  it('drops clinicians who left, falling back to the default when nobody is left', () => {
    expect(effectiveSelection([4, 7], clinicians, OWNER)).toEqual([7]);
    expect(effectiveSelection([4], clinicians, OWNER)).toEqual([1]);
    expect(effectiveSelection([4], clinicians, SCHEDULER)).toBe('all');
    expect(effectiveSelection([4], undefined, OWNER)).toEqual([4]);
  });

  it('shows the selected clinicians', () => {
    expect(selectedClinicians('all', clinicians)).toHaveLength(3);
    expect(selectedClinicians([2], clinicians).map((clinician) => clinician.name)).toEqual(['Jordan']);
  });
});
