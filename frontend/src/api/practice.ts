import { api, downloadFile } from './client';
import type { ClientRef, ClientStatus } from './clients';

export type TaxIdType = 'EIN' | 'SSN';

/** Who is the billing provider on claims and superbills. */
export type BillingProvider = 'individual' | 'organization';

/** The practice (the account everyone on the team belongs to). */
export interface Practice {
  id: number;
  name: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  time_zone: string;
  tax_id: string;
  tax_id_type: TaxIdType;
  /** The practice's group (type 2) NPI. */
  npi: string;
  taxonomy_code: string;
  billing_provider: BillingProvider;
  booking_slug: string | null;
}

export type PracticeUpdate = Partial<Omit<Practice, 'id'>>;

/** Practice-wide policies. Personal preferences live on the staff member (see api/me.ts). */
export interface PracticeSettings {
  cancellation_window_hours: number;
  booking_enabled: boolean;
  booking_accepts_new_clients: boolean;
  booking_min_notice_hours: number;
  booking_max_days_ahead: number;
  booking_slot_interval_minutes: number;
  booking_intro: string;
  reminder_email_enabled: boolean;
  reminder_email_hours: number;
  reminder_sms_enabled: boolean;
  reminder_sms_hours: number;
  messaging_enabled: boolean;
  waiting_room_enabled: boolean;
  recording_enabled: boolean;
  bill_missed_appointments: boolean;
  autopay_enabled: boolean;
  invoice_due_days: number;
  /** How many years records are kept after a client's last activity (6 to 100). */
  record_retention_years: number;
  /** Good Faith Estimates (No Surprises Act) for self-pay and uninsured clients. */
  gfe_enabled: boolean;
}

/** Shortest and longest record retention the practice can choose, in years. */
export const MIN_RETENTION_YEARS = 6;
export const MAX_RETENTION_YEARS = 100;

export interface Service {
  id: number;
  code: string;
  description: string;
  duration_minutes: number;
  rate_cents: number;
  is_default: boolean;
  is_active: boolean;
  bookable_online: boolean;
  bookable_by_new_clients: boolean;
}

export type ServiceInput = Omit<Service, 'id'>;

/** An office, or a video office, where appointments take place. */
export interface Location {
  id: number;
  name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  /** CMS place-of-service code printed on claims (two digits). */
  place_of_service: string;
  is_video: boolean;
  is_active: boolean;
}

export type LocationInput = Omit<Location, 'id'>;

/** The place-of-service codes most practices use; any other two-digit code is allowed too. */
export const PLACE_OF_SERVICE_OPTIONS: { code: string; label: string }[] = [
  { code: '11', label: 'Office' },
  { code: '02', label: 'Telehealth (not at home)' },
  { code: '10', label: 'Telehealth at home' },
];

/** `system`: background jobs, Stripe webhooks and the server's admin commands. */
export type AuditActorRole = 'staff' | 'client' | 'anonymous' | 'system';

export interface AuditEvent {
  id: number;
  actor_role: AuditActorRole;
  actor_id: number | null;
  /** The team member's name for staff actions; empty for clients and anonymous events. */
  actor_name: string;
  /** The client whose record the event touched, if any. */
  client_id: number | null;
  client_name: string;
  action: string;
  resource_type: string;
  resource_id: number | null;
  ip_address: string;
  user_agent: string;
  /** Ids and counts only (never clinical content), e.g. which fields changed. */
  detail: Record<string, unknown> | null;
  created_at: string;
  /** Whether the event has been sealed into the practice's tamper-evident hash chain. */
  sealed: boolean;
}

/** One page of audit events, newest first; pass `next_cursor` as `cursor` for the next page. */
export interface AuditLogPage {
  events: AuditEvent[];
  next_cursor: number | null;
}

/** Filters for the practice audit log. `action` is a prefix such as "note." or "note.view". */
export interface AuditLogFilters {
  client_id?: number;
  actor_id?: number;
  action?: string;
  /** Inclusive start, UTC ISO datetime. */
  from?: string;
  /** Exclusive end, UTC ISO datetime. */
  to?: string;
}

export type AuditExportFormat = 'csv' | 'ndjson';

/** Whether the practice's audit hash chain verifies, and where its head is. */
export interface AuditIntegrity {
  verified: boolean;
  problem: string | null;
  head_event_id: number | null;
  head_hash: string | null;
  sealed_events: number;
  unsealed_events: number;
  last_checkpoint_at: string | null;
}

/** An archived client whose record retention period has passed (nothing is deleted). */
export interface RetentionEntry {
  client: ClientRef;
  status: ClientStatus;
  last_activity_at: string | null;
  retention_ends_on: string;
}

export const AUDIT_LOG_PAGE_SIZE = 100;

/** Practice details, practice-wide settings, services, locations and the audit log. The
 * practice itself arrives with the session (`useSession().practice`). */
export const practiceApi = {
  update: (changes: PracticeUpdate) => api<Practice>('/practice', { method: 'PATCH', body: changes }),
  settings: () => api<PracticeSettings>('/practice/settings'),
  updateSettings: (changes: Partial<PracticeSettings>) =>
    api<PracticeSettings>('/practice/settings', { method: 'PATCH', body: changes }),
  services: () => api<Service[]>('/practice/services'),
  createService: (input: ServiceInput) => api<Service>('/practice/services', { body: input }),
  updateService: (id: number, changes: Partial<ServiceInput>) =>
    api<Service>(`/practice/services/${id}`, { method: 'PATCH', body: changes }),
  locations: () => api<Location[]>('/practice/locations'),
  createLocation: (input: LocationInput) => api<Location>('/practice/locations', { body: input }),
  updateLocation: (id: number, changes: Partial<LocationInput>) =>
    api<Location>(`/practice/locations/${id}`, { method: 'PATCH', body: changes }),
  auditLog: (filters: AuditLogFilters = {}, cursor?: number) =>
    api<AuditLogPage>('/practice/audit-log', {
      query: { ...filters, cursor, limit: AUDIT_LOG_PAGE_SIZE },
    }),
  /** Download the events matching `filters` with the chain head and verification status. */
  exportAuditLog: (format: AuditExportFormat, filters: AuditLogFilters = {}) =>
    downloadFile(`/practice/audit-log/export?${new URLSearchParams(queryString({ format, ...filters }))}`),
  auditIntegrity: () => api<AuditIntegrity>('/practice/audit-log/integrity'),
  retentionReport: () => api<RetentionEntry[]>('/practice/retention-report'),
};

/** Query parameters without empty values, as strings. */
function queryString(values: Record<string, string | number | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') result[key] = String(value);
  }
  return result;
}

export const practiceKeys = {
  settings: ['practice', 'settings'] as const,
  services: ['practice', 'services'] as const,
  locations: ['practice', 'locations'] as const,
  auditLog: (filters: AuditLogFilters = {}) => ['practice', 'audit-log', filters] as const,
  auditIntegrity: ['practice', 'audit-log', 'integrity'] as const,
  retentionReport: ['practice', 'retention-report'] as const,
};
