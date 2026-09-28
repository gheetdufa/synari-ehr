import { describe, expect, it } from 'vitest';
import type { Service } from '../../../api/practice';
import type { TeamMember } from '../../../api/team';
import {
  EMPTY_INVITE,
  assignableRoles,
  inviteInput,
  memberDraft,
  memberUpdate,
  rateRows,
  ratesInput,
  roleSummary,
  supervisorOptions,
  validateInvite,
  validateMember,
} from './teamRules';

function member(changes: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 7,
    email: 'jordan@example.com',
    first_name: 'Jordan',
    last_name: 'Park',
    display_name: 'Jordan Park, LMFT',
    status: 'active',
    role: 'clinician',
    clinician_access: 'basic',
    is_clinician: true,
    supervisor_id: null,
    credentials: 'LMFT',
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

describe('invite validation', () => {
  const valid = { ...EMPTY_INVITE, email: 'jordan@example.com', first_name: 'Jordan', last_name: 'Park' };

  it.each([
    ['a complete invitation', {}, {}],
    ['a missing email', { email: ' ' }, { email: 'Enter their email address' }],
    ['a malformed email', { email: 'jordan@' }, { email: 'Enter a valid email address, like name@example.com' }],
    ['missing names', { first_name: '', last_name: ' ' }, { first_name: 'Enter their first name', last_name: 'Enter their last name' }],
  ])('%s', (_case, changes, errors) => {
    expect(validateInvite({ ...valid, ...changes })).toEqual(errors);
  });
});

describe('invite payload', () => {
  const base = { ...EMPTY_INVITE, email: ' jordan@example.com ', first_name: ' Jordan ', last_name: 'Park' };

  it('invites a clinician with their access level, supervisor and credentials', () => {
    expect(
      inviteInput({ ...base, role: 'clinician', clinician_access: 'client_list', supervisor_id: '3', credentials: ' LMFT ' }),
    ).toEqual({
      email: 'jordan@example.com',
      first_name: 'Jordan',
      last_name: 'Park',
      role: 'clinician',
      clinician_access: 'client_list',
      is_clinician: true,
      supervisor_id: 3,
      credentials: 'LMFT',
    });
  });

  it("drops clinical fields for staff who won't see clients", () => {
    expect(
      inviteInput({ ...base, role: 'biller', clinician_access: 'practice', also_sees_clients: true, supervisor_id: '3', credentials: 'CPC' }),
    ).toMatchObject({ role: 'biller', clinician_access: 'basic', is_clinician: false, supervisor_id: null, credentials: '' });
  });

  it('lets an owner or practice manager also see clients', () => {
    expect(inviteInput({ ...base, role: 'practice_manager', also_sees_clients: true })).toMatchObject({ is_clinician: true });
    expect(inviteInput({ ...base, role: 'owner', also_sees_clients: false })).toMatchObject({ is_clinician: false });
  });
});

describe('roles', () => {
  it('only lets owners hand out the owner role', () => {
    expect(assignableRoles('owner')).toContain('owner');
    expect(assignableRoles('practice_manager')).toEqual(['clinician', 'practice_manager', 'biller', 'scheduler']);
  });

  it('summarizes role and access', () => {
    expect(roleSummary(member({ clinician_access: 'practice' }))).toBe('Clinician · Full practice');
    expect(roleSummary(member({ role: 'owner', is_clinician: true }))).toBe('Owner · Sees clients');
    expect(roleSummary(member({ role: 'biller', is_clinician: false }))).toBe('Biller');
  });

  it('offers active clinicians other than the person as supervisors', () => {
    const team = [
      member({ id: 1 }),
      member({ id: 2, status: 'invited' }),
      member({ id: 3, role: 'biller', is_clinician: false }),
      member({ id: 7 }),
    ];
    expect(supervisorOptions(team, 7).map((option) => option.id)).toEqual([1]);
  });
});

describe('member update', () => {
  it('sends only what changed', () => {
    const jordan = member();
    expect(memberUpdate(jordan, memberDraft(jordan))).toEqual({});
    expect(memberUpdate(jordan, { ...memberDraft(jordan), npi: ' 1234567890 ', supervisor_id: '1' })).toEqual({
      npi: '1234567890',
      supervisor_id: 1,
    });
  });

  it('checks and sends the claim licensure modifier', () => {
    const jordan = member();
    expect(validateMember({ ...memberDraft(jordan), claim_modifier: 'H' })).toEqual({
      claim_modifier: 'A modifier is 2 letters or digits, like HO',
    });
    expect(validateMember({ ...memberDraft(jordan), claim_modifier: '' })).toEqual({});
    expect(memberUpdate(jordan, { ...memberDraft(jordan), claim_modifier: 'HO' })).toEqual({ claim_modifier: 'HO' });
  });

  it('clears clinician details when someone stops seeing clients', () => {
    const jordan = member({ supervisor_id: 1 });
    expect(memberUpdate(jordan, { ...memberDraft(jordan), role: 'scheduler' })).toEqual({
      role: 'scheduler',
      is_clinician: false,
      supervisor_id: null,
    });
  });
});

describe('clinician rates', () => {
  const services = [
    { id: 1, code: '90834', rate_cents: 15000 },
    { id: 2, code: '90837', rate_cents: 18000 },
  ] as Service[];

  it('starts from the saved overrides, with blank meaning the practice rate', () => {
    const rows = rateRows(services, [{ service_id: 2, offered: false, rate_cents: 17000 }]);
    expect(rows.map(({ offered, rate }) => ({ offered, rate }))).toEqual([
      { offered: true, rate: '' },
      { offered: false, rate: '170.00' },
    ]);
  });

  it('validates amounts and builds the full list', () => {
    const rows = rateRows(services, []);
    expect(ratesInput([{ ...rows[0], rate: '$160' }, rows[1]])).toEqual({
      errors: {},
      rates: [
        { service_id: 1, offered: true, rate_cents: 16000 },
        { service_id: 2, offered: true, rate_cents: null },
      ],
    });
    expect(ratesInput([{ ...rows[0], rate: 'lots' }, rows[1]]).errors).toEqual({ 1: 'Enter an amount like 150 or 150.00' });
  });
});
