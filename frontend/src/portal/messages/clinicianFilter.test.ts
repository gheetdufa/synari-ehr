import { describe, expect, it } from 'vitest';
import { testSession } from '../../test/session';
import { teamMember } from '../../test/team';
import { clinicianFilterOptions, defaultClinicianFilter, readableClinicians } from './clinicianFilter';

// Dana (id 1) is signed in; Sam and Ari are colleagues, and Ari is supervised by Dana.
const DANA = teamMember(1, { display_name: 'Dana Lee, LCSW' });
const SAM = teamMember(2, { display_name: 'Sam Ortiz, PhD' });
const ARI = teamMember(3, { display_name: 'Ari Moss, LMFT', supervisor_id: 1 });
const TEAM = [
  DANA,
  SAM,
  ARI,
  teamMember(4, { display_name: 'Former Clinician', status: 'deactivated', supervisor_id: 1 }),
  teamMember(5, { display_name: 'Riley Biller', is_clinician: false, role: 'biller' }),
];

const owner = testSession();
const basicClinician = testSession({ staff: { role: 'clinician', clinician_access: 'basic' }, capabilities: [] });
const nonClinicalOwner = testSession({ staff: { id: 9, is_clinician: false } });

describe('readableClinicians', () => {
  it.each([
    ['staff who open every chart see every other active clinician', owner, ['Sam Ortiz, PhD', 'Ari Moss, LMFT']],
    ['a clinician sees their active supervisees', basicClinician, ['Ari Moss, LMFT']],
    ['a non-clinical owner sees every active clinician', nonClinicalOwner, ['Dana Lee, LCSW', 'Sam Ortiz, PhD', 'Ari Moss, LMFT']],
  ])('%s', (_case, session, names) => {
    expect(readableClinicians(session, TEAM).map((member) => member.display_name)).toEqual(names);
  });
});

describe('clinicianFilterOptions', () => {
  it.each([
    ['a clinician who only sees their own', basicClinician, [], []],
    ['a supervisor', basicClinician, [ARI], ['My conversations', 'All conversations', 'Ari Moss, LMFT']],
    ['an owner-clinician in a solo practice', owner, [], ['My conversations', 'All conversations']],
    ['an owner-clinician', owner, [SAM, ARI], ['My conversations', 'All conversations', 'Ari Moss, LMFT', 'Sam Ortiz, PhD']],
    ['an owner who doesn’t see clients', nonClinicalOwner, [SAM, ARI], ['All conversations', 'Ari Moss, LMFT', 'Sam Ortiz, PhD']],
  ])('lists the choices for %s', (_case, session, others, labels) => {
    expect(clinicianFilterOptions(session, others).map((option) => option.label)).toEqual(labels);
  });

  it('filters by clinician id, with "all" as the catch-all value', () => {
    expect(clinicianFilterOptions(owner, [SAM, ARI]).map((option) => option.value)).toEqual([1, 'all', 3, 2]);
  });
});

describe('defaultClinicianFilter', () => {
  it('starts clinicians on their own conversations and everyone else on all of them', () => {
    expect(defaultClinicianFilter(owner)).toBe(1);
    expect(defaultClinicianFilter(basicClinician)).toBe(1);
    expect(defaultClinicianFilter(nonClinicalOwner)).toBe('all');
  });
});
