import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import type { InsurancePolicy } from '../../api/clients';
import { ROLE_SESSIONS, testClient, testContact } from '../../test/clients';
import { newClientInput, validateNewClient, type NewClientDraft } from './AddClientModal';
import { billingUpdate } from './BillingSection';
import { canInviteToPortal, portalStatusText } from './ClientHeader';
import { uploaderLabel } from '../forms/ClientFilesSection';
import { careTeamInput } from './CareTeamSection';
import { visibleTabs } from './ClientDetailPage';
import { ageOn, clientTabFrom, contactName, isIcd10, statusFilterFrom, todayIn } from './clientHelpers';
import { billsClientsOf, canAddClients, choosesPrimaryClinician, clientPermissions } from './clientPermissions';
import { careTeamLabel } from './ClientsPage';
import { contactDraft, contactInput } from './ContactModal';
import { contactPortalText } from './ContactsSection';
import { coverageDates, subscriberSummary } from './InsuranceSection';
import { clinicalUpdate, withoutBlankRows } from './ClinicalSection';
import { blankToNull, centsToInput, changedFields, fieldErrors } from './formUtils';
import { policyDraft, policyInput } from './InsurancePolicyModal';
import { contactUpdate, personalUpdate } from './PersonalSections';

const client = testClient({ preferred_name: 'Lex', diagnosis_codes: [{ code: 'F41.1', description: 'GAD' }] });

describe('clientHelpers', () => {
  it.each([
    ['1990-06-15', '2026-06-14', 35],
    ['1990-06-15', '2026-06-15', 36],
    ['2000-02-29', '2026-02-28', 25],
    ['2000-02-29', '2026-03-01', 26],
  ])('ageOn(%s, %s) = %i', (dob, today, age) => {
    expect(ageOn(dob, today)).toBe(age);
  });

  it('computes the date in a time zone', () => {
    const instant = new Date('2026-09-26T02:30:00Z');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-09-25');
    expect(todayIn('Asia/Tokyo', instant)).toBe('2026-09-26');
  });

  it('maps ?tab= values, accepting forms as an alias', () => {
    expect(clientTabFrom('forms')).toBe('documents');
    expect(clientTabFrom('billing')).toBe('billing');
    expect(clientTabFrom('estimates')).toBe('estimates');
    expect(clientTabFrom('nonsense')).toBe('overview');
    expect(clientTabFrom(null)).toBe('overview');
  });

  it('checks ICD-10 shape like the API', () => {
    expect(isIcd10('F41.1')).toBe(true);
    expect(isIcd10(' f32.a ')).toBe(true);
    expect(isIcd10('Z63')).toBe(true);
    expect(isIcd10('U07.1')).toBe(false);
    expect(isIcd10('41.1')).toBe(false);
    expect(isIcd10('F41.12345')).toBe(false);
  });

  it('defaults the status filter to active', () => {
    expect(statusFilterFrom(null)).toBe('active');
    expect(statusFilterFrom('all')).toBe('all');
    expect(statusFilterFrom('deleted')).toBe('active');
  });
});

describe('formUtils', () => {
  it('keeps only changed fields, comparing arrays by value', () => {
    const changes = changedFields(client, {
      first_name: 'Alex',
      pronouns: 'she/her',
      diagnosis_codes: [{ code: 'F41.1', description: 'GAD' }],
      email: 'alex@example.com',
    });
    expect(changes).toEqual({ pronouns: 'she/her' });
  });

  it('turns 422 details into dotted field paths', () => {
    const error = new ApiError(422, [
      { loc: ['body', 'diagnosis_codes', 1, 'code'], msg: 'Value error, X99 is not a valid ICD-10 code' },
      { loc: ['body', 'email'], msg: 'value is not a valid email address' },
      { loc: ['body'], msg: 'Model-level problem' },
    ]);
    expect(fieldErrors(error)).toEqual({
      'diagnosis_codes.1.code': 'X99 is not a valid ICD-10 code',
      email: 'Value is not a valid email address',
    });
    expect(fieldErrors(new ApiError(409, 'Another client already uses this email'))).toEqual({});
    expect(fieldErrors(new Error('boom'))).toEqual({});
  });

  it('normalizes blanks and money inputs', () => {
    expect(blankToNull('  ')).toBeNull();
    expect(blankToNull(' a@b.co ')).toBe('a@b.co');
    expect(centsToInput(null)).toBe('');
    expect(centsToInput(12550)).toBe('125.50');
  });
});

describe('add client', () => {
  const draft: NewClientDraft = {
    first_name: ' Sam ',
    last_name: 'Lee',
    preferred_name: '',
    email: '',
    phone: '',
    date_of_birth: '',
    primary_clinician_id: '',
    billing_type: 'insurance',
    send_portal_invite: true,
  };

  it('requires names, a sensible birth date and (when choosing one) a primary clinician', () => {
    expect(validateNewClient({ ...draft, first_name: ' ', last_name: '' }, '2026-09-25', false)).toEqual({
      first_name: 'Enter a first name',
      last_name: 'Enter a last name',
    });
    expect(validateNewClient({ ...draft, date_of_birth: '2030-01-01' }, '2026-09-25', false)).toHaveProperty('date_of_birth');
    expect(validateNewClient({ ...draft, email: 'nope' }, '2026-09-25', false)).toHaveProperty('email');
    expect(validateNewClient(draft, '2026-09-25', false)).toEqual({});
    expect(validateNewClient(draft, '2026-09-25', true)).toEqual({ primary_clinician_id: 'Choose a primary clinician' });
    expect(validateNewClient({ ...draft, primary_clinician_id: '3' }, '2026-09-25', true)).toEqual({});
  });

  it('only invites when there is an email', () => {
    const options = { choosesPrimary: false, setsBilling: true };
    expect(newClientInput(draft, options)).toMatchObject({ first_name: 'Sam', email: null, date_of_birth: null, send_portal_invite: false });
    expect(newClientInput({ ...draft, email: 'sam@example.com' }, options).send_portal_invite).toBe(true);
  });

  it('sends the chosen primary clinician, and the billing type only with billing access', () => {
    const chosen = { ...draft, primary_clinician_id: '3' };
    expect(newClientInput(chosen, { choosesPrimary: true, setsBilling: false })).toMatchObject({ primary_clinician_id: 3 });
    expect(newClientInput(chosen, { choosesPrimary: true, setsBilling: false })).not.toHaveProperty('billing_type');
    const own = newClientInput(chosen, { choosesPrimary: false, setsBilling: true });
    expect(own).not.toHaveProperty('primary_clinician_id');
    expect(own.billing_type).toBe('insurance');
  });
});

describe('chart sections', () => {
  it('validates personal details and clears an empty birth date', () => {
    const result = personalUpdate(
      {
        first_name: 'Alex',
        last_name: '',
        preferred_name: '',
        pronouns: '',
        date_of_birth: '',
        sex: '',
        gender_identity: '',
        is_minor: true,
        referral_source: '',
      },
      '2026-09-25',
    );
    expect(result.errors).toEqual({ last_name: 'Enter a last name' });
    expect(result.update).toMatchObject({ date_of_birth: null, is_minor: true });
  });

  it('sends null for a cleared email and time zone', () => {
    const { update, errors } = contactUpdate({
      email: ' ',
      phone: '555',
      address_line1: '',
      address_line2: '',
      city: '',
      state: '',
      postal_code: '',
      time_zone: '',
    });
    expect(errors).toEqual({});
    expect(update).toMatchObject({ email: null, time_zone: null, phone: '555' });
    expect(contactUpdate({ ...{ phone: '', address_line1: '', address_line2: '', city: '', state: '', postal_code: '', time_zone: '' }, email: 'x@' }).errors).toHaveProperty('email');
  });

  it('drops blank diagnosis rows and flags invalid codes by index', () => {
    const rows = withoutBlankRows([
      { key: 1, code: 'f41.1', description: 'Anxiety' },
      { key: 2, code: '', description: '' },
      { key: 3, code: 'BAD', description: '' },
    ]);
    expect(rows.map((row) => row.key)).toEqual([1, 3]);
    const { update, errors } = clinicalUpdate({ diagnosis_codes: rows, internal_notes: 'n' });
    expect(update.diagnosis_codes?.[0]).toEqual({ code: 'F41.1', description: 'Anxiety' });
    expect(errors).toEqual({ 'diagnosis_codes.1.code': 'BAD is not a valid ICD-10 code' });
  });

  it('parses a custom rate in dollars', () => {
    expect(billingUpdate({ billing_type: 'insurance', default_service_id: '3', rate: '$1,200.50' }).update).toEqual({
      billing_type: 'insurance',
      default_service_id: 3,
      rate_override_cents: 120050,
    });
    expect(billingUpdate({ billing_type: 'self_pay', default_service_id: '', rate: '' }).update.rate_override_cents).toBeNull();
    expect(billingUpdate({ billing_type: 'self_pay', default_service_id: '', rate: 'abc' }).errors).toHaveProperty(
      'rate_override_cents',
    );
  });

  it('describes portal status and when an invite can be sent', () => {
    expect(portalStatusText(client)).toBe("Hasn't signed in to the portal yet");
    expect(canInviteToPortal(client)).toBe(true);
    expect(portalStatusText({ ...client, portal_enabled: false })).toBe('Portal access is off');
    expect(canInviteToPortal({ ...client, status: 'archived' })).toBe(false);
    expect(canInviteToPortal({ ...client, email: null })).toBe(false);
  });
});

describe('insurance policies', () => {
  const policy: InsurancePolicy = {
    id: 1,
    client_id: 7,
    payer_id: 4,
    payer: { id: 4, name: 'Aetna', external_id: '60054' },
    rank: 'secondary',
    member_id: 'M1',
    group_number: '',
    plan_name: '',
    subscriber_relationship: '01',
    subscriber_first_name: 'Pat',
    subscriber_last_name: 'Rivera',
    subscriber_dob: '1980-01-01',
    subscriber_sex: 'F',
    subscriber_address_line1: '1 Main St',
    subscriber_address_line2: '',
    subscriber_city: 'Austin',
    subscriber_state: 'TX',
    subscriber_postal_code: '78701',
    claim_filing_indicator: '',
    effective_date: '2026-01-01',
    termination_date: null,
    copay_cents: null,
    coinsurance_percent: 20,
    authorizations: [],
  };

  it('clears subscriber details when the client is the subscriber', () => {
    const draft = { ...policyDraft(policy, 'primary'), subscriber_relationship: '18' as const, copay: '25' };
    const { input, errors } = policyInput(draft);
    expect(errors).toEqual({});
    expect(input).toMatchObject({
      payer_id: 4,
      copay_cents: 2500,
      coinsurance_percent: 20,
      subscriber_relationship: '18',
      subscriber_first_name: '',
      subscriber_dob: null,
      subscriber_sex: '',
      subscriber_city: '',
    });
  });

  it('requires the payer, and the subscriber details when someone else is the subscriber', () => {
    const blank = { ...policyDraft(null, 'primary'), subscriber_relationship: '19' as const };
    expect(Object.keys(policyInput(blank).errors).sort()).toEqual([
      'payer_id',
      'subscriber_address_line1',
      'subscriber_city',
      'subscriber_dob',
      'subscriber_first_name',
      'subscriber_last_name',
      'subscriber_postal_code',
      'subscriber_sex',
      'subscriber_state',
    ]);
    expect(policyInput(policyDraft(policy, 'primary')).errors).toEqual({});
  });

  it('checks dates, copay and coinsurance', () => {
    const draft = policyDraft(policy, 'primary');
    expect(policyInput({ ...draft, termination_date: '2025-12-31' }).errors).toHaveProperty('termination_date');
    expect(policyInput({ ...draft, copay: 'abc' }).errors).toHaveProperty('copay_cents');
    expect(policyInput({ ...draft, coinsurance: '120' }).errors).toHaveProperty('coinsurance_percent');
    expect(policyInput({ ...draft, coinsurance: '15%' }).input.coinsurance_percent).toBe(15);
    expect(policyInput({ ...draft, coinsurance: '' }).input.coinsurance_percent).toBeNull();
  });

  it('round-trips a policy through the form', () => {
    expect(policyDraft(policy, 'primary')).toMatchObject({ payer_id: '4', rank: 'secondary', copay: '', coinsurance: '20' });
    expect(policyDraft(null, 'secondary')).toMatchObject({ payer_id: '', rank: 'secondary', subscriber_relationship: '18' });
  });

  it('summarizes the subscriber and coverage dates', () => {
    expect(subscriberSummary(policy)).toBe('Pat Rivera · Female · born Jan 1, 1980 · client is their spouse');
    expect(subscriberSummary({ ...policy, subscriber_relationship: '18' })).toBe('Client');
    expect(coverageDates(policy)).toBe('From Jan 1, 2026');
    expect(coverageDates({ effective_date: null, termination_date: null })).toBe('');
  });
});

describe('contacts', () => {
  const draft = contactDraft(null);

  it('requires a first name, a valid email, and an email for portal access', () => {
    expect(contactInput(draft).errors).toEqual({ first_name: 'Enter a first name' });
    expect(contactInput({ ...draft, first_name: 'Pat', email: 'pat@' }).errors).toEqual({ email: 'Enter a valid email address' });
    expect(contactInput({ ...draft, first_name: 'Pat', portal_access: true }).errors).toEqual({
      email: 'Enter an email address to give this contact portal access',
    });
  });

  it('builds a tidy payload', () => {
    const { input, errors } = contactInput({
      ...draft,
      first_name: ' Pat ',
      email: ' Pat@Example.com ',
      relation: ' Mother ',
      is_guardian: true,
      portal_access: true,
    });
    expect(errors).toEqual({});
    expect(input).toEqual({
      first_name: 'Pat',
      last_name: '',
      relation: 'Mother',
      email: 'pat@example.com',
      phone: '',
      is_guardian: true,
      is_emergency_contact: false,
      responsible_for_billing: false,
      portal_access: true,
    });
    expect(contactInput({ ...draft, first_name: 'Pat', email: '  ' }).input.email).toBeNull();
  });

  it('describes a contact and their portal sign-ins', () => {
    const contact = testContact({ portal_access: true });
    expect(contactName(contact)).toBe('Pat Rivera');
    expect(contactName({ first_name: 'Pat', last_name: '' })).toBe('Pat');
    expect(contactPortalText(contact)).toBe("Hasn't signed in to the portal yet");
    expect(contactPortalText({ ...contact, portal_last_login_at: new Date().toISOString() })).toBe('Last portal sign-in just now');
  });
});

describe('care team and permissions', () => {
  it('never lists the primary clinician twice', () => {
    expect(careTeamInput('', [2])).toEqual({ input: null, error: 'Choose a primary clinician' });
    expect(careTeamInput('3', [2, 3, 2, 1]).input).toEqual({ primary_clinician_id: 3, clinician_ids: [1, 2] });
  });

  it('labels the care team with the primary clinician first', () => {
    const team = [
      { staff_id: 2, name: 'Sam Ortiz, LPC', is_primary: false },
      { staff_id: 1, name: 'Dana Lee, LCSW', is_primary: true },
    ];
    expect(careTeamLabel(team)).toBe('Dana Lee, LCSW +1');
    expect(careTeamLabel([])).toBe('');
  });

  // Alex's primary clinician is Dana (the owner); Sam is also on the care team.
  const alex = testClient({
    care_team: [
      { staff_id: 1, name: 'Dana Lee, LCSW', is_primary: true },
      { staff_id: 2, name: 'Sam Ortiz, LPC', is_primary: false },
    ],
  });
  it.each([
    [
      'owner',
      { clinical: true, billing: true },
      { editProfile: true, editCareTeam: true, schedule: true, accessHistory: true },
    ],
    [
      'clinician',
      { clinical: true, billing: false },
      { editProfile: true, editCareTeam: false, schedule: true, accessHistory: false },
    ],
    [
      'scheduler',
      { clinical: false, billing: false },
      { editProfile: true, editCareTeam: true, schedule: true, accessHistory: false },
    ],
    [
      'biller',
      { clinical: false, billing: true },
      { editProfile: false, editCareTeam: false, schedule: false, accessHistory: false },
    ],
  ] as const)('%s may do what their role allows', (role, access, expected) => {
    const permissions = clientPermissions(ROLE_SESSIONS[role], { ...alex, access });
    expect(permissions).toEqual({ ...access, ...expected });
  });

  it('lets the primary clinician edit the care team and see who opened the record', () => {
    const samsClient = testClient({ care_team: [{ staff_id: 2, name: 'Sam Ortiz, LPC', is_primary: true }] });
    expect(clientPermissions(ROLE_SESSIONS.clinician, samsClient).editCareTeam).toBe(true);
    expect(clientPermissions(ROLE_SESSIONS.clinician, samsClient).accessHistory).toBe(true);
  });

  it('decides who adds clients, and who picks the primary clinician and billing type', () => {
    expect(canAddClients(ROLE_SESSIONS.clinician)).toBe(true);
    expect(canAddClients(ROLE_SESSIONS.scheduler)).toBe(true);
    expect(canAddClients(ROLE_SESSIONS.biller)).toBe(false);
    expect(choosesPrimaryClinician(ROLE_SESSIONS.owner)).toBe(true);
    expect(choosesPrimaryClinician(ROLE_SESSIONS.clinician)).toBe(false);
    expect(billsClientsOf(ROLE_SESSIONS.owner, 3)).toBe(true);
    expect(billsClientsOf(ROLE_SESSIONS.scheduler, 5)).toBe(false);
    const billingClinician = { ...ROLE_SESSIONS.clinician, capabilities: ['billing_own' as const] };
    expect(billsClientsOf(billingClinician, 2)).toBe(true);
    expect(billsClientsOf(billingClinician, 1)).toBe(false);
  });

  it('shows chart tabs by access', () => {
    expect(visibleTabs({ clinical: true, billing: true, accessHistory: true })).toEqual([
      'overview',
      'appointments',
      'notes',
      'documents',
      'billing',
      'estimates',
      'privacy',
      'access',
    ]);
    expect(visibleTabs({ clinical: true, billing: false, accessHistory: false })).toEqual([
      'overview',
      'appointments',
      'notes',
      'documents',
      'estimates',
      'privacy',
    ]);
    expect(visibleTabs({ clinical: false, billing: true, accessHistory: false })).toEqual([
      'overview',
      'appointments',
      'documents',
      'billing',
      'estimates',
    ]);
    expect(visibleTabs({ clinical: false, billing: false, accessHistory: true })).toEqual([
      'overview',
      'appointments',
      'documents',
      'access',
    ]);
    expect(visibleTabs({ clinical: false, billing: false, accessHistory: false })).toEqual(['overview', 'appointments', 'documents']);
  });

  it('names who uploaded a document', () => {
    const file = {
      id: 1,
      client_id: 7,
      purpose: 'shared_document' as const,
      filename: 'npp.pdf',
      content_type: 'application/pdf',
      size_bytes: 10,
      uploaded_by: 'staff' as const,
      uploaded_by_staff_id: 2,
      shared_with_client: true,
      category: '',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(uploaderLabel(file, 2, [])).toBe('Uploaded by you');
    expect(uploaderLabel(file, 1, [])).toBe('Uploaded by a team member');
    expect(uploaderLabel({ ...file, uploaded_by: 'client', uploaded_by_staff_id: null }, 1, [])).toBe(
      'Uploaded from the client portal',
    );
  });
});
