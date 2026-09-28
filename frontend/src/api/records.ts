import { api, downloadFile } from './client';
import type { ClientRef } from './clients';
import type { StaffRef } from './notes';

/**
 * Patients' rights on the staff side: requests for a copy of the record (right of access, due in
 * 30 days with one 30-day extension), the accounting of disclosures, and amendment requests (due
 * in 60 days). Everything here needs clinical access to the client.
 */

export type RecordRequestStatus = 'open' | 'fulfilled' | 'denied';
export type RecordDelivery = 'portal' | 'third_party';
export type RequestedBy = 'client' | 'contact' | 'staff';
export type AmendmentStatus = 'open' | 'accepted' | 'denied';

export const RECORD_DELIVERY_LABELS: Record<RecordDelivery, string> = {
  portal: 'Download in the client portal',
  third_party: 'Send to someone the client named',
};

export const REQUESTED_BY_LABELS: Record<RequestedBy, string> = {
  client: 'Client (portal)',
  contact: 'Client contact (portal)',
  staff: 'Entered by staff',
};

/** A request for a copy of a client's record. */
export interface RecordRequest {
  id: number;
  client: ClientRef;
  requested_by: RequestedBy;
  requested_by_contact_id: number | null;
  received_at: string;
  /** "YYYY-MM-DD"; moves 30 days later when extended. */
  due_on: string;
  /** Negative once overdue. */
  days_left: number;
  overdue: boolean;
  extended_on: string | null;
  extension_reason: string;
  scope: string;
  delivery: RecordDelivery;
  recipient: string;
  status: RecordRequestStatus;
  fulfilled_at: string | null;
  fulfilled_by: StaffRef | null;
  release_expires_at: string | null;
  release_available: boolean;
  denial_reason: string;
  created_at: string;
}

export interface RecordRequestInput {
  scope: string;
  delivery: RecordDelivery;
  recipient?: string;
  /** "YYYY-MM-DD" when the request arrived (defaults to today). */
  received_at?: string;
}

export interface FulfillInput {
  include_billing?: boolean;
  /** How it was sent (third-party delivery only). */
  note?: string;
}

/** How a disclosure was logged: entered by hand, by a record export, or by a record request. */
export type DisclosureSource = 'manual' | 'export' | 'record_request';

/** A disclosure outside treatment, payment and operations, kept for the accounting. */
export interface Disclosure {
  id: number;
  client_id: number;
  disclosed_on: string;
  recipient_name: string;
  recipient_address: string;
  description: string;
  purpose: string;
  legal_basis: string;
  /** Only manual entries can be edited or removed. */
  source: DisclosureSource;
  /** Set when the disclosure came from a record request. */
  record_request_id: number | null;
  recorded_by: StaffRef | null;
  created_at: string;
}

export interface DisclosureInput {
  disclosed_on: string;
  recipient_name: string;
  recipient_address?: string;
  description: string;
  purpose: string;
  legal_basis?: string;
}

/** The accounting of disclosures for the last six years. */
export interface DisclosureReport {
  client_id: number;
  client_name: string;
  practice_name: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  disclosures: Disclosure[];
}

/** A client's request to amend their record. */
export interface AmendmentRequest {
  id: number;
  client: ClientRef;
  note_id: number | null;
  note_title: string;
  requested_by: RequestedBy;
  received_at: string;
  due_on: string;
  days_left: number;
  overdue: boolean;
  request: string;
  status: AmendmentStatus;
  decided_at: string | null;
  decided_by: StaffRef | null;
  denial_reason: string;
  /** The client's statement of disagreement after a denial. */
  disagreement: string;
  /** The practice's response to the disagreement. */
  rebuttal: string;
  addendum_id: number | null;
  created_at: string;
}

export interface AmendmentInput {
  request: string;
  note_id?: number;
}

export interface RecordRequestFilters {
  status?: RecordRequestStatus;
  client_id?: number;
}

export interface AmendmentFilters {
  status?: AmendmentStatus;
  client_id?: number;
}

/** Server limits on the text fields. */
export const MAX_SCOPE_CHARS = 2_000;
export const MAX_RECIPIENT_CHARS = 1_000;
export const MAX_REASON_CHARS = 1_000;
export const MAX_DENIAL_CHARS = 2_000;
export const MAX_REQUEST_CHARS = 5_000;
export const MAX_ADDENDUM_CHARS = 20_000;
export const MAX_DELIVERY_NOTE_CHARS = 500;

export const recordsApi = {
  requests: (filters: RecordRequestFilters = {}) => api<RecordRequest[]>('/record-requests', { query: { ...filters } }),
  request: (id: number) => api<RecordRequest>(`/record-requests/${id}`),
  createRequest: (clientId: number, input: RecordRequestInput) =>
    api<RecordRequest>(`/clients/${clientId}/record-requests`, { body: input }),
  extend: (id: number, reason: string) => api<RecordRequest>(`/record-requests/${id}/extend`, { body: { reason } }),
  /** Download what would be released, for sending it to a third party yourself. */
  downloadPackage: (id: number, includeBilling: boolean) =>
    downloadFile(`/record-requests/${id}/package`, { body: { include_billing: includeBilling } }),
  fulfill: (id: number, input: FulfillInput) => api<RecordRequest>(`/record-requests/${id}/fulfill`, { body: input }),
  deny: (id: number, reason: string) => api<RecordRequest>(`/record-requests/${id}/deny`, { body: { reason } }),

  disclosures: (clientId: number) => api<Disclosure[]>(`/clients/${clientId}/disclosures`),
  createDisclosure: (clientId: number, input: DisclosureInput) =>
    api<Disclosure>(`/clients/${clientId}/disclosures`, { body: input }),
  updateDisclosure: (id: number, changes: Partial<DisclosureInput>) =>
    api<Disclosure>(`/disclosures/${id}`, { method: 'PATCH', body: changes }),
  removeDisclosure: (id: number) => api<void>(`/disclosures/${id}`, { method: 'DELETE' }),
  disclosureReport: (clientId: number) =>
    api<DisclosureReport>(`/clients/${clientId}/disclosures/report`, { query: { format: 'json' } }),
  downloadDisclosureReport: (clientId: number, format: 'pdf' | 'csv') =>
    downloadFile(`/clients/${clientId}/disclosures/report?format=${format}`),

  amendments: (filters: AmendmentFilters = {}) =>
    api<AmendmentRequest[]>('/amendment-requests', { query: { ...filters } }),
  amendment: (id: number) => api<AmendmentRequest>(`/amendment-requests/${id}`),
  createAmendment: (clientId: number, input: AmendmentInput) =>
    api<AmendmentRequest>(`/clients/${clientId}/amendment-requests`, { body: input }),
  acceptAmendment: (id: number, input: { content: string; note_id?: number }) =>
    api<AmendmentRequest>(`/amendment-requests/${id}/accept`, { body: input }),
  denyAmendment: (id: number, reason: string) =>
    api<AmendmentRequest>(`/amendment-requests/${id}/deny`, { body: { reason } }),
  addRebuttal: (id: number, rebuttal: string) =>
    api<AmendmentRequest>(`/amendment-requests/${id}/rebuttal`, { body: { rebuttal } }),
};

export const recordKeys = {
  all: ['records'] as const,
  requests: ['records', 'requests'] as const,
  requestList: (filters: RecordRequestFilters) => ['records', 'requests', filters] as const,
  disclosures: (clientId: number) => ['records', 'disclosures', clientId] as const,
  disclosureReport: (clientId: number) => ['records', 'disclosures', clientId, 'report'] as const,
  amendments: ['records', 'amendments'] as const,
  amendmentList: (filters: AmendmentFilters) => ['records', 'amendments', filters] as const,
};
