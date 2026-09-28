import type { Session } from '../api/auth';
import type { ClientContact, ClientDetail } from '../api/clients';
import { testSession } from './session';

/**
 * Signed-in sessions for each kind of team member in the client tests: the owner-clinician
 * (Dana, id 1), a basic clinician (Sam, id 2), and a scheduler (id 5) and biller (id 6) who don't
 * see clients clinically.
 */
export const ROLE_SESSIONS = {
  owner: testSession(),
  clinician: testSession({
    staff: { id: 2, first_name: 'Sam', last_name: 'Ortiz', display_name: 'Sam Ortiz, LPC', role: 'clinician' },
    capabilities: [],
  }),
  scheduler: testSession({
    staff: { id: 5, first_name: 'Robin', last_name: 'Hale', display_name: 'Robin Hale', role: 'scheduler', is_clinician: false },
    capabilities: ['view_all_clients', 'schedule_all'],
  }),
  biller: testSession({
    staff: { id: 6, first_name: 'Kim', last_name: 'Nguyen', display_name: 'Kim Nguyen', role: 'biller', is_clinician: false },
    capabilities: ['view_all_clients', 'billing_all', 'view_reports'],
  }),
} satisfies Record<string, Session>;

/**
 * A client record for tests: Alex Rivera, active, with Dana Lee (staff id 1, the owner in
 * `testSession()`) as primary clinician and full access, unless overridden.
 */
export function testClient(overrides: Partial<ClientDetail> = {}): ClientDetail {
  return {
    id: 7,
    first_name: 'Alex',
    last_name: 'Rivera',
    preferred_name: '',
    status: 'active',
    email: 'alex@example.com',
    phone: '555-0100',
    date_of_birth: '1990-06-15',
    created_at: '2026-01-01T00:00:00Z',
    care_team: [{ staff_id: 1, name: 'Dana Lee, LCSW', is_primary: true }],
    pronouns: 'they/them',
    sex: '',
    gender_identity: '',
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    postal_code: '',
    time_zone: null,
    is_minor: false,
    contacts: [],
    referral_source: '',
    internal_notes: '',
    diagnosis_codes: [],
    billing_type: 'self_pay',
    default_service_id: null,
    rate_override_cents: null,
    autopay_enabled: false,
    email_reminders: true,
    sms_reminders: false,
    sms_opted_out: false,
    portal_enabled: true,
    portal_messaging: true,
    portal_booking: true,
    portal_billing: true,
    portal_last_login_at: null,
    updated_at: '2026-01-01T00:00:00Z',
    access: { clinical: true, billing: true },
    ...overrides,
  };
}

/** A contact of client 7 for tests: Pat Rivera, a parent with no special roles unless overridden. */
export function testContact(overrides: Partial<ClientContact> = {}): ClientContact {
  return {
    id: 31,
    client_id: 7,
    first_name: 'Pat',
    last_name: 'Rivera',
    relation: 'Parent',
    email: 'pat@example.com',
    phone: '',
    is_emergency_contact: false,
    is_guardian: false,
    responsible_for_billing: false,
    portal_access: false,
    portal_last_login_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
