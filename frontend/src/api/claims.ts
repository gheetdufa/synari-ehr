import { ApiError, api, apiPage, downloadFile, type PageParams } from './client';
import type { EligibilityStatus } from './insurance';

export type ClaimStatus = 'draft' | 'queued' | 'submitted' | 'accepted' | 'rejected' | 'denied' | 'paid' | 'void';

/** stedi: sent by the clearinghouse; x12_file: a downloaded 837P file; paper: a printed CMS-1500. */
export type SubmissionMethod = 'stedi' | 'x12_file' | 'paper';

/** P primary, S secondary, T tertiary. */
export type PayerResponsibility = 'P' | 'S' | 'T';

/** One problem that would get the claim rejected. `field` points into the claim document. */
export interface ClaimIssue {
  code: string;
  field: string;
  message: string;
}

export interface ClaimValidation {
  claim_id: number;
  patient_control_number: string;
  issues: ClaimIssue[];
}

export interface ClaimLine {
  id: number;
  participant_id: number | null;
  appointment_id: number | null;
  line_control_number: string;
  /** Plain date (YYYY-MM-DD). */
  service_date: string;
  procedure_code: string;
  modifiers: string[];
  units: number;
  charge_cents: number;
  place_of_service: string;
  /** 1-based positions in the claim's diagnosis list. */
  diagnosis_pointers: number[];
  allowed_cents: number | null;
  paid_cents: number;
  adjustment_cents: number;
  patient_responsibility_cents: number;
}

export interface ClaimEvent {
  id: number;
  /**
   * created, updated, queued, submitted, accepted, rejected, file_accepted, paid, denied,
   * reversed, corrected, void_requested, voided, secondary_created
   */
  kind: string;
  message: string;
  data: Record<string, unknown> | null;
  staff_id: number | null;
  created_at: string;
}

export interface ClaimDiagnosis {
  code: string;
  description: string;
}

export interface Claim {
  id: number;
  client_id: number;
  client_name: string;
  policy_id: number;
  payer_id: number;
  payer_name: string;
  payer_responsibility: PayerResponsibility;
  status: ClaimStatus;
  submission_method: SubmissionMethod;
  /** Our claim number, e.g. "SYN00DX42". */
  patient_control_number: string;
  /** 1 original, 7 corrected, 8 void. */
  frequency_code: string;
  original_claim_id: number | null;
  primary_claim_id: number | null;
  payer_claim_number: string;
  rendering_clinician_id: number;
  rendering_clinician_name: string;
  supervising_clinician_id: number | null;
  supervising_clinician_name: string;
  place_of_service: string;
  prior_authorization_number: string;
  /** ICD-10 codes without the dot, in claim order. */
  diagnosis_codes: string[];
  total_charge_cents: number;
  paid_cents: number;
  adjustment_cents: number;
  patient_responsibility_cents: number;
  insurance_balance_cents: number;
  first_service_date: string | null;
  last_service_date: string | null;
  clearinghouse_ref: string;
  submitted_at: string | null;
  adjudicated_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface ClaimDetail extends Claim {
  lines: ClaimLine[];
  events: ClaimEvent[];
  /** What would stop the claim from being accepted, computed now. */
  issues: ClaimIssue[];
  diagnoses: ClaimDiagnosis[];
}

export interface ClaimCreate {
  participant_ids: number[];
  /** Omit to use the client's active primary policy. */
  policy_id?: number;
  payer_responsibility?: PayerResponsibility;
}

export interface ClaimLineUpdate {
  id: number;
  procedure_code?: string;
  modifiers?: string[];
  units?: number;
  place_of_service?: string;
  diagnosis_pointers?: number[];
}

export interface ClaimUpdate {
  diagnosis_codes?: string[];
  place_of_service?: string;
  prior_authorization_number?: string;
  payer_claim_number?: string;
  rendering_clinician_id?: number;
  supervising_clinician_id?: number | null;
  lines?: ClaimLineUpdate[];
}

/** An attended session of an insurance client that isn't on a claim yet. */
export interface UnbilledSession {
  participant_id: number;
  appointment_id: number;
  client_id: number;
  client_name: string;
  clinician_id: number;
  clinician_name: string;
  starts_at: string;
  service_date: string;
  service_code: string;
  service_description: string;
  fee_cents: number;
  location_type: string;
  policy_id: number;
  payer_id: number;
  payer_name: string;
  note_signed: boolean;
  has_diagnoses: boolean;
  eligibility_status: EligibilityStatus | null;
}

/** Filters for the unbilled queue and the claims list (dates are YYYY-MM-DD). */
export interface ClaimFilters {
  clinician_id?: number;
  payer_id?: number;
  client_id?: number;
  start?: string;
  end?: string;
}

/** The claims list's filters plus a status. */
export interface ClaimListParams extends ClaimFilters, PageParams {
  status?: ClaimStatus;
}

/** How many claims have one status, and their money (void and denied claims owe no insurance balance). */
export interface ClaimStatusSummary {
  status: ClaimStatus;
  claims: number;
  charged_cents: number;
  paid_cents: number;
  patient_responsibility_cents: number;
  insurance_balance_cents: number;
}

/** The per-claim problems of a 422 from submit, or null for any other error. */
export function rejectedClaims(error: unknown): ClaimValidation[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const detail = error.detail as { claims?: unknown } | null;
  return detail && Array.isArray(detail.claims) ? (detail.claims as ClaimValidation[]) : null;
}

/** Insurance claims: the sessions waiting to be billed, drafting, editing and submitting. */
export const claimsApi = {
  /** Sessions ready to file, by client (last name) and then date. */
  unbilled: (params: ClaimFilters & PageParams = {}) =>
    apiPage<UnbilledSession>('/claims/unbilled', { query: { ...params } }),
  /** Claims, newest first. */
  list: (params: ClaimListParams = {}) => apiPage<Claim>('/claims', { query: { ...params } }),
  /** Claim counts and totals per status for the filters. */
  summary: (filters: ClaimFilters = {}) => api<ClaimStatusSummary[]>('/claims/summary', { query: { ...filters } }),
  get: (claimId: number) => api<ClaimDetail>(`/claims/${claimId}`),
  /** Draft claims for sessions of one client (split so each claim has at most 6 dates). */
  create: (input: ClaimCreate) => api<Claim[]>('/claims', { body: input }),
  update: (claimId: number, changes: ClaimUpdate) =>
    api<ClaimDetail>(`/claims/${claimId}`, { method: 'PATCH', body: changes }),
  validate: (claimId: number) => api<ClaimValidation>(`/claims/${claimId}/validate`, { method: 'POST' }),
  /**
   * Submit draft or rejected claims. The clearinghouse queues them (returns the claims); an 837P
   * file or CMS-1500 forms are downloaded (returns nothing). A 422 carries each claim's issues
   * (see `rejectedClaims`) and submits nothing.
   */
  submit: async (claimIds: number[], method: SubmissionMethod): Promise<Claim[] | null> => {
    const body = { claim_ids: claimIds, method };
    if (method === 'stedi') return api<Claim[]>('/claims/submit', { body });
    await downloadFile('/claims/submit', {
      body,
      filename: method === 'x12_file' ? 'claims-837p.txt' : 'cms1500-claims.pdf',
    });
    return null;
  },
  correct: (claimId: number) => api<ClaimDetail>(`/claims/${claimId}/correct`, { method: 'POST' }),
  void: (claimId: number) => api<ClaimDetail>(`/claims/${claimId}/void`, { method: 'POST' }),
  secondary: (claimId: number) => api<ClaimDetail>(`/claims/${claimId}/secondary`, { method: 'POST' }),
  downloadCms1500: (claim: Pick<Claim, 'id' | 'patient_control_number'>) =>
    downloadFile(`/claims/${claim.id}/cms1500.pdf`, { filename: `cms1500-${claim.patient_control_number}.pdf` }),
};

export const claimsKeys = {
  all: ['claims'] as const,
  /** The ready-to-file queue (an infinite query). */
  unbilled: (filters: ClaimFilters) => ['claims', 'unbilled', filters] as const,
  /** How many sessions are ready to file. */
  unbilledCount: (filters: ClaimFilters) => ['claims', 'unbilled-count', filters] as const,
  /** The claims list (an infinite query). */
  list: (params: ClaimListParams) => ['claims', 'list', params] as const,
  summary: (filters: ClaimFilters) => ['claims', 'summary', filters] as const,
  /** The most recent claims for the filters, for matching insurance payments by hand. */
  recent: (filters: ClaimFilters) => ['claims', 'recent', filters] as const,
  detail: (claimId: number) => ['claims', 'detail', claimId] as const,
};
