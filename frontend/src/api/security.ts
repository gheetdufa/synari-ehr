import { api } from './client';

/** A device signed in to your account. */
export interface AuthSession {
  id: string;
  /** Readable browser and system, e.g. "Chrome on macOS". */
  device: string;
  user_agent: string;
  ip_address: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** The session making this request (this device). */
  current: boolean;
}

/** Practice-wide sign-in rules. `mfa_server_policy` is set by the server administrator and wins. */
export interface PracticeSecurity {
  require_staff_mfa: boolean;
  mfa_server_policy: 'required' | 'off' | null;
  /** Whether two-factor authentication is required in effect (practice setting or server policy). */
  mfa_required: boolean;
  session_idle_minutes: number;
  staff_mfa_enabled: number;
  staff_active: number;
}

export type PracticeSecurityUpdate = Partial<Pick<PracticeSecurity, 'require_staff_mfa' | 'session_idle_minutes'>>;

/** The idle sign-out limits a practice can choose, in minutes. */
export const IDLE_TIMEOUT_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;

export type SecurityEventSeverity = 'info' | 'warning' | 'critical';

/** Something that may need a look, such as repeated failed sign-ins or emergency chart access. */
export interface SecurityEvent {
  id: number;
  kind: string;
  /** What happened, in words, e.g. "Repeated failed sign-ins". */
  label: string;
  severity: SecurityEventSeverity;
  staff_id: number | null;
  staff_name: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by_name: string;
}

export const SECURITY_EVENTS_PAGE_SIZE = 50;

/** Your signed-in devices, the practice's sign-in rules and its security events. */
export const securityApi = {
  sessions: () => api<AuthSession[]>('/me/sessions'),
  revokeSession: (sessionId: string) =>
    api<void>(`/me/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  practice: () => api<PracticeSecurity>('/practice/security'),
  updatePractice: (changes: PracticeSecurityUpdate) =>
    api<PracticeSecurity>('/practice/security', { method: 'PATCH', body: changes }),
  /** Newest first; `beforeId` pages back from the last event already loaded. */
  events: (needsReview: boolean, beforeId?: number) =>
    api<SecurityEvent[]>('/practice/security-events', {
      query: { unacknowledged: needsReview, before_id: beforeId, limit: SECURITY_EVENTS_PAGE_SIZE },
    }),
  acknowledgeEvent: (eventId: number) =>
    api<SecurityEvent>(`/practice/security-events/${eventId}/acknowledge`, { method: 'POST' }),
};

export const securityKeys = {
  sessions: ['me', 'sessions'] as const,
  practice: ['practice', 'security'] as const,
  events: ['practice', 'security-events'] as const,
  eventList: (needsReview: boolean) => ['practice', 'security-events', { needsReview }] as const,
};
