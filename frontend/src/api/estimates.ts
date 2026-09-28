import { api, downloadFile } from './client';
import type { ClientRef } from './clients';

/**
 * Good Faith Estimates (No Surprises Act): the expected charges for a self-pay or uninsured
 * client's care over up to 12 months. Issued estimates never change; a change in services, fees
 * or frequency issues a new estimate that replaces (supersedes) the old one.
 */

export type EstimateStatus = 'draft' | 'issued' | 'superseded' | 'void';
/** Why an estimate is needed: a session was scheduled, the client asked, the care changed, or staff started one. */
export type EstimateReason = 'scheduling' | 'request' | 'update' | 'manual';
export type EstimateDelivery = 'portal' | 'email' | 'paper' | 'mail';

export interface EstimateDiagnosis {
  code: string;
  description: string;
}

/** An item or service another provider is expected to schedule separately. */
export interface SeparatelyScheduledItem {
  description: string;
  provider: string;
  note: string;
}

export interface EstimateItemInput {
  description: string;
  service_code: string;
  location: string;
  /** Letters into the estimate's diagnosis list (A = first). */
  diagnosis_pointers: string[];
  unit_fee_cents: number;
  quantity: number;
  /** e.g. "Weekly". */
  frequency: string;
}

export interface EstimateItem extends EstimateItemInput {
  id: number;
  total_cents: number;
}

/** The editable part of an estimate (dates are plain YYYY-MM-DD). */
export interface EstimateDraftInput {
  clinician_id: number;
  period_start: string;
  period_end: string;
  primary_service: string;
  scheduled_dates: string[];
  diagnosis_codes: EstimateDiagnosis[];
  items: EstimateItemInput[];
  separately_scheduled: SeparatelyScheduledItem[];
  notes: string;
  /** What changed from the estimate this one replaces (required to issue a replacement). */
  change_summary: string;
  due_on: string | null;
}

/** The provider as printed on the estimate: stored when issued, a live preview while a draft. */
export interface EstimateProvider {
  name: string;
  credentials: string;
  type: string;
  practice_name: string;
  address_lines: string[];
  contact: string;
  phone: string;
  email: string;
  npi: string;
  npi_kind: 'individual' | 'group';
  tin: string;
  tin_type: string;
  states: string[];
  locations: string[];
}

export interface Estimate {
  id: number;
  client: ClientRef;
  clinician_id: number;
  clinician_name: string;
  status: EstimateStatus;
  supersedes_id: number | null;
  /** The estimate that replaced this one, once issued. */
  superseded_by_id: number | null;
  change_summary: string;
  reason: EstimateReason;
  due_on: string | null;
  overdue: boolean;
  period_start: string;
  period_end: string;
  primary_service: string;
  scheduled_dates: string[];
  diagnosis_codes: EstimateDiagnosis[];
  items: EstimateItem[];
  separately_scheduled: SeparatelyScheduledItem[];
  notes: string;
  total_cents: number;
  provider: EstimateProvider;
  /** Identifiers needed before a draft can be issued, e.g. "NPI". */
  missing_provider_fields: string[];
  issued_at: string | null;
  issued_by_name: string;
  delivery_method: EstimateDelivery;
  pdf_sha256: string;
  acknowledged_at: string | null;
  acknowledged_name: string;
  voided_at: string | null;
  void_reason: string;
  created_at: string;
  updated_at: string;
}

/** A practice service as estimated for one clinician (their rate). */
export interface EstimateServiceOption {
  service_id: number;
  code: string;
  description: string;
  duration_minutes: number;
  rate_cents: number;
}

export interface EstimateClinicianOption {
  id: number;
  name: string;
  services: EstimateServiceOption[];
  /** A draft filled in from the client's upcoming sessions with this clinician. */
  suggested: EstimateDraftInput | null;
}

/** What the estimate form offers for a client. */
export interface EstimateOptions {
  enabled: boolean;
  self_pay: boolean;
  /** The clinicians this person may write estimates for. */
  clinicians: EstimateClinicianOption[];
  diagnoses: EstimateDiagnosis[];
  locations: string[];
  default_clinician_id: number | null;
  /** Client details needed before issuing, e.g. "date of birth". */
  missing_client_fields: string[];
}

/** A client and clinician who need a (new) estimate. */
export interface EstimateNeed {
  client: ClientRef;
  clinician_id: number;
  clinician_name: string;
  reason: EstimateReason;
  due_on: string | null;
  overdue: boolean;
  /** The open draft, if one was started. */
  estimate_id: number | null;
  uncovered_sessions: number;
  next_session_at: string | null;
}

// Client portal ------------------------------------------------------------------------------

export interface PortalEstimate {
  id: number;
  clinician_name: string;
  status: EstimateStatus;
  period_start: string;
  period_end: string;
  primary_service: string;
  total_cents: number;
  issued_at: string | null;
  change_summary: string;
  acknowledged_at: string | null;
  acknowledged_name: string;
}

export interface PortalEstimates {
  enabled: boolean;
  estimates: PortalEstimate[];
  clinicians: { id: number; name: string }[];
  /** A request (or a scheduled estimate) is already waiting on the practice. */
  request_pending: boolean;
}

/** Staff estimate endpoints: billing access to the client, or the client's own clinician. */
export const estimatesApi = {
  forClient: (clientId: number) => api<Estimate[]>(`/clients/${clientId}/estimates`),
  options: (clientId: number) => api<EstimateOptions>(`/clients/${clientId}/estimates/options`),
  create: (clientId: number, input: EstimateDraftInput) =>
    api<Estimate>(`/clients/${clientId}/estimates`, { body: input }),
  needed: () => api<EstimateNeed[]>('/estimates/needed'),
  get: (id: number) => api<Estimate>(`/estimates/${id}`),
  update: (id: number, input: EstimateDraftInput) => api<Estimate>(`/estimates/${id}`, { method: 'PUT', body: input }),
  remove: (id: number) => api<void>(`/estimates/${id}`, { method: 'DELETE' }),
  issue: (id: number, deliveryMethod: EstimateDelivery) =>
    api<Estimate>(`/estimates/${id}/issue`, { body: { delivery_method: deliveryMethod } }),
  supersede: (id: number, changeSummary: string) =>
    api<Estimate>(`/estimates/${id}/supersede`, { body: { change_summary: changeSummary } }),
  void: (id: number, reason: string) => api<Estimate>(`/estimates/${id}/void`, { body: { reason } }),
  downloadPdf: (id: number) => downloadFile(`/estimates/${id}/pdf`),
};

/** Query keys for staff estimates; invalidate `estimateKeys.all` after any change. */
export const estimateKeys = {
  all: ['estimates'] as const,
  forClient: (clientId: number) => ['estimates', 'client', clientId] as const,
  options: (clientId: number) => ['estimates', 'options', clientId] as const,
  needed: ['estimates', 'needed'] as const,
};

/** The signed-in client's estimates. */
export const portalEstimatesApi = {
  list: () => api<PortalEstimates>('/portal/estimates', { realm: 'client' }),
  downloadPdf: (id: number) => downloadFile(`/portal/estimates/${id}/pdf`, { realm: 'client' }),
  acknowledge: (id: number, name: string) =>
    api<PortalEstimate>(`/portal/estimates/${id}/acknowledge`, { realm: 'client', body: { name } }),
  request: (clinicianId?: number) =>
    api<{ detail: string }>('/portal/estimates/request', {
      realm: 'client',
      body: clinicianId === undefined ? {} : { clinician_id: clinicianId },
    }),
};

export const portalEstimateKeys = {
  all: ['portal', 'estimates'] as const,
};
