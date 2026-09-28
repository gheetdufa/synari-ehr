import { ApiError, api, tokenStore, type TokenPair } from './client';
import type { Practice } from './practice';

export type StaffRole = 'owner' | 'clinician' | 'practice_manager' | 'biller' | 'scheduler';

/** How much of the practice a clinician (role `clinician`) sees beyond their own clients. */
export type ClinicianAccess = 'basic' | 'billing' | 'client_list' | 'practice';

export type StaffStatus = 'invited' | 'active' | 'deactivated';

/** What a staff member's role lets them do (mirrors the API's `permissions.py`). */
export type Capability =
  | 'manage_team'
  | 'manage_practice'
  | 'view_all_clients'
  | 'clinical_all'
  | 'schedule_all'
  | 'billing_own'
  | 'billing_all'
  | 'view_reports'
  | 'view_audit_log';

/** The API's password length limits. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

/** Hint shown under every new-password field. */
export const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words make a strong, memorable password.`;

/** The length check the browser can do; the API also rejects common, personal and breached passwords. */
export function newPasswordError(password: string): string | null {
  return password.length < MIN_PASSWORD_LENGTH ? `Use at least ${MIN_PASSWORD_LENGTH} characters` : null;
}

/**
 * Which password field a 400 from a password endpoint belongs on: the current password ("Current
 * password is incorrect") or the new one (too common, based on your name, found in a breach).
 * Null for anything else, such as an expired invitation or reset link.
 */
export function passwordErrorField(error: unknown): 'current' | 'new' | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  if (/current password/i.test(error.message)) return 'current';
  return /password/i.test(error.message) ? 'new' : null;
}

export const ROLE_LABELS: Record<StaffRole, string> = {
  owner: 'Owner',
  clinician: 'Clinician',
  practice_manager: 'Practice manager',
  biller: 'Biller',
  scheduler: 'Scheduler',
};

/** The signed-in staff member's own account. */
export interface StaffMember {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  /** Name with credentials, e.g. "Jordan Lee, LCSW". */
  display_name: string;
  status: StaffStatus;
  role: StaffRole;
  clinician_access: ClinicianAccess;
  /** Sees clients (always true for clinicians; optional for owners and practice managers). */
  is_clinician: boolean;
  supervisor_id: number | null;
  credentials: string;
  license_number: string;
  license_state: string;
  npi: string;
  taxonomy_code: string;
  phone: string;
  time_zone: string;
  accepting_new_clients: boolean;
  mfa_enabled: boolean;
}

/** Who is signed in, their practice, and what their role lets them do. */
export interface Session {
  staff: StaffMember;
  practice: Practice;
  capabilities: Capability[];
  /**
   * Two-factor authentication is required and this person hasn't set it up: until they do, the
   * API only answers enrollment and sign-out calls.
   */
  mfa_setup_required: boolean;
  /** Minutes without activity before this session is signed out. */
  idle_timeout_minutes: number;
}

/** A staff invitation, shown on the join page before the invitee chooses a password. */
export interface Invitation {
  email: string;
  first_name: string;
  last_name: string;
  practice_name: string;
  role: StaffRole;
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  first_name?: string;
  last_name?: string;
}

/** A contact (e.g. a minor's parent) signed in to the client's portal on their behalf. */
export interface ActingContact {
  id: number;
  name: string;
}

/** The client whose portal is open, and who signed in. */
export interface PortalClient {
  id: number;
  first_name: string;
  last_name: string;
  preferred_name: string;
  email: string | null;
  clinician_name: string;
  practice_name: string;
  time_zone: string;
  permissions: { messaging: boolean; booking: boolean; billing: boolean };
  /** Set when a guardian or other contact signed in rather than the client. */
  acting_contact: ActingContact | null;
  /** Minutes without activity before the portal signs out. */
  idle_timeout_minutes: number;
}

export interface PublicConfig {
  registration_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  payments_enabled: boolean;
  telehealth_enabled: boolean;
  ai_enabled: boolean;
  livekit_url: string;
  currency: string;
  /** Largest file an import (e.g. a SimplePractice export) may upload. */
  import_max_bytes?: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  practice_name?: string;
  time_zone?: string;
  /** False for an owner who runs the practice but doesn't see clients. */
  is_clinician?: boolean;
}

type StaffAuthResponse = TokenPair & Session;
type MfaChallenge = { mfa_required: true; mfa_token: string };

/** Outcome of a password step: signed in, or a second factor is needed. */
export type SignInResult = { status: 'signedIn'; session: Session } | { status: 'mfa'; mfaToken: string };

/** Keep the tokens and return the session part of a token-issuing response. */
function adopt({ access_token, refresh_token, expires_in, ...session }: StaffAuthResponse): Session {
  tokenStore.set('staff', { access_token, refresh_token, expires_in });
  return session;
}

function signInResult(data: StaffAuthResponse | MfaChallenge): SignInResult {
  if ('mfa_required' in data) return { status: 'mfa', mfaToken: data.mfa_token };
  return { status: 'signedIn', session: adopt(data) };
}

type PortalAuthResponse = TokenPair & { client: PortalClient };

/** Staff sign-in, registration, invitations and password endpoints. */
export const staffAuth = {
  async login(email: string, password: string): Promise<SignInResult> {
    return signInResult(
      await api<StaffAuthResponse | MfaChallenge>('/auth/login', { realm: null, body: { email, password } }),
    );
  },
  /** Second sign-in step with an authenticator or recovery code. */
  async completeMfa(mfaToken: string, code: string): Promise<Session> {
    return adopt(
      await api<StaffAuthResponse>('/auth/login/mfa', { realm: null, body: { mfa_token: mfaToken, code } }),
    );
  },
  /** Create a practice with the registering person as its owner. */
  async register(input: RegisterInput): Promise<Session> {
    return adopt(await api<StaffAuthResponse>('/auth/register', { realm: null, body: input }));
  },
  invitation: (token: string) =>
    api<Invitation>(`/auth/invitations/${encodeURIComponent(token)}`, { realm: null }),
  /** Join a practice from an invitation: choose a password and start a session. */
  async acceptInvitation(input: AcceptInvitationInput): Promise<Session> {
    return adopt(await api<StaffAuthResponse>('/auth/invitations/accept', { realm: null, body: input }));
  },
  /** Sign out this device. */
  async logout(): Promise<void> {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      tokenStore.clear('staff');
    }
  },
  /** Sign out every device, this one included. Throws (keeping this device signed in) on failure. */
  async logoutEverywhere(): Promise<void> {
    await api<{ detail: string }>('/auth/logout-everywhere', { method: 'POST' });
    tokenStore.clear('staff');
  },
  requestPasswordReset: (email: string) =>
    api<{ detail: string }>('/auth/password-reset/request', { realm: null, body: { email } }),
  async confirmPasswordReset(token: string, newPassword: string): Promise<SignInResult> {
    return signInResult(
      await api<StaffAuthResponse | MfaChallenge>('/auth/password-reset/confirm', {
        realm: null,
        body: { token, new_password: newPassword },
      }),
    );
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<Session> {
    return adopt(
      await api<StaffAuthResponse>('/auth/change-password', {
        body: { current_password: currentPassword, new_password: newPassword },
      }),
    );
  },
};

export const authKeys = {
  invitation: (token: string) => ['auth', 'invitation', token] as const,
};

/** Two-factor authentication management for the signed-in staff member. */
export const mfaApi = {
  setup: () => api<{ secret: string; otpauth_uri: string }>('/auth/mfa/setup', { method: 'POST' }),
  enable: (code: string) => api<{ recovery_codes: string[] }>('/auth/mfa/enable', { body: { code } }),
  disable: (password: string, code: string) =>
    api<{ detail: string }>('/auth/mfa/disable', { body: { password, code } }),
  regenerateRecoveryCodes: (password: string, code: string) =>
    api<{ recovery_codes: string[] }>('/auth/mfa/recovery-codes', { body: { password, code } }),
};

/** Client-portal sign-in with one-time email links. */
export const portalAuth = {
  requestLink: (email: string) =>
    api<{ detail: string }>('/portal/auth/request-link', { realm: null, body: { email } }),
  async verify(token: string): Promise<PortalClient> {
    const data = await api<PortalAuthResponse>('/portal/auth/verify', {
      realm: null,
      body: { token },
    });
    tokenStore.set('client', data);
    return data.client;
  },
  me: () => api<PortalClient>('/portal/auth/me', { realm: 'client' }),
  async logout(): Promise<void> {
    try {
      await api('/portal/auth/logout', { realm: 'client', method: 'POST' });
    } finally {
      tokenStore.clear('client');
    }
  },
};

/** Which optional integrations this server has configured. */
export const fetchPublicConfig = () => api<PublicConfig>('/config', { realm: null });
