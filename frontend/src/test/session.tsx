import type { ReactNode } from 'react';
import type { Capability, Session, StaffMember } from '../api/auth';
import type { Practice } from '../api/practice';
import { StaffAuthContext, type StaffAuthValue } from '../auth/StaffAuth';

const OWNER_CAPABILITIES: Capability[] = [
  'billing_all',
  'billing_own',
  'clinical_all',
  'manage_practice',
  'manage_team',
  'schedule_all',
  'view_all_clients',
  'view_audit_log',
  'view_reports',
];

/** A signed-in session for tests: an owner-clinician of "Lee Counseling" unless overridden. */
export function testSession(
  overrides: {
    staff?: Partial<StaffMember>;
    practice?: Partial<Practice>;
    capabilities?: Capability[];
    mfa_setup_required?: boolean;
    idle_timeout_minutes?: number;
  } = {},
): Session {
  return {
    staff: {
      id: 1,
      email: 'dana@example.com',
      first_name: 'Dana',
      last_name: 'Lee',
      display_name: 'Dana Lee, LCSW',
      status: 'active',
      role: 'owner',
      clinician_access: 'basic',
      is_clinician: true,
      supervisor_id: null,
      credentials: 'LCSW',
      license_number: '',
      license_state: '',
      npi: '',
      taxonomy_code: '',
      phone: '',
      time_zone: 'America/New_York',
      accepting_new_clients: true,
      mfa_enabled: false,
      ...overrides.staff,
    },
    practice: {
      id: 501,
      name: 'Lee Counseling',
      phone: '',
      address_line1: '',
      address_line2: '',
      city: '',
      state: '',
      postal_code: '',
      time_zone: 'America/New_York',
      tax_id: '',
      tax_id_type: 'EIN',
      npi: '',
      taxonomy_code: '',
      billing_provider: 'individual',
      booking_slug: null,
      ...overrides.practice,
    },
    capabilities: overrides.capabilities ?? OWNER_CAPABILITIES,
    mfa_setup_required: overrides.mfa_setup_required ?? false,
    idle_timeout_minutes: overrides.idle_timeout_minutes ?? 30,
  };
}

/** Provides a signed-in staff session without the network. */
export function WithSession({
  session,
  setSession = () => Promise.resolve(),
  logout = () => Promise.resolve(),
  logoutEverywhere = () => Promise.resolve(),
  children,
}: {
  session: Session;
  setSession?: StaffAuthValue['setSession'];
  logout?: StaffAuthValue['logout'];
  logoutEverywhere?: StaffAuthValue['logoutEverywhere'];
  children: ReactNode;
}) {
  const unused = () => Promise.reject(new Error('Not available in tests'));
  const value: StaffAuthValue = {
    status: 'signedIn',
    session,
    login: unused,
    completeMfa: unused,
    register: unused,
    acceptInvitation: unused,
    logout,
    logoutEverywhere,
    setSession,
  };
  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>;
}
