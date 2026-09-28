import { api, apiPage, downloadFile, uploadFile, type PageParams } from './client';

export type RemittanceStatus = 'unposted' | 'posted' | 'needs_review';

/** CO contractual, PR patient responsibility, OA other, PI payer initiated. */
export interface Adjustment {
  group_code: string;
  reason_code: string;
  amount_cents: number;
  quantity: number;
}

export interface RemittanceLine {
  procedure_code: string;
  modifiers: string[];
  units: number;
  line_control_number: string;
  service_date: string | null;
  charge_cents: number;
  paid_cents: number;
  allowed_cents: number | null;
  adjustments: Adjustment[];
  remark_codes: string[];
}

/** One claim payment in a remittance; `claim_id` is null when it matched none of our claims. */
export interface RemittanceClaim {
  id: number;
  claim_id: number | null;
  client_id: number | null;
  client_name: string;
  patient_control_number: string;
  status_code: string;
  status_description: string;
  charge_cents: number;
  paid_cents: number;
  patient_responsibility_cents: number;
  payer_claim_number: string;
  adjustments: Adjustment[];
  lines: RemittanceLine[];
  posted_at: string | null;
}

/** A provider-level adjustment (PLB): positive amounts reduce the payment. */
export interface ProviderAdjustment {
  provider_id: string;
  reason_code: string;
  amount_cents: number;
  reference: string;
  fiscal_period_date: string | null;
}

export interface Remittance {
  id: number;
  payer_id: number | null;
  payer_name: string;
  trace_number: string;
  payment_method: string;
  payment_date: string | null;
  total_paid_cents: number;
  provider_adjustments: ProviderAdjustment[];
  status: RemittanceStatus;
  /** "stedi" (received automatically) or "upload". */
  source: string;
  file_id: number | null;
  posted_at: string | null;
  created_at: string;
  claim_count: number;
  unmatched_count: number;
}

export interface RemittanceDetail extends Remittance {
  claims: RemittanceClaim[];
}

export interface RemittanceAssignment {
  remittance_claim_id: number;
  claim_id: number;
}

/** What an uploaded clearinghouse file did. */
export interface ResponseFileResult {
  /** 835 remittance, 277 claim acknowledgment, 999 file acknowledgment. */
  kind: '835' | '277' | '999';
  remittances: Remittance[];
  /** Claims whose status changed. */
  claim_ids: number[];
  message: string;
}

export interface RemittanceListParams extends PageParams {
  status?: RemittanceStatus;
}

/** Insurance payments (835 ERAs) and uploaded clearinghouse response files. */
export const remittancesApi = {
  /** Remittances, newest first. */
  list: (params: RemittanceListParams = {}) => apiPage<Remittance>('/remittances', { query: { ...params } }),
  get: (remittanceId: number) => api<RemittanceDetail>(`/remittances/${remittanceId}`),
  /** Import an 835, 277CA or 999 file (409 when the remittance was already imported). */
  upload: (file: File) => uploadFile<ResponseFileResult>('/remittances/upload', file),
  /** Post after review, matching unmatched claim payments to claims first. */
  post: (remittanceId: number, assignments: RemittanceAssignment[]) =>
    api<RemittanceDetail>(`/remittances/${remittanceId}/post`, { body: { assignments } }),
  downloadFile: (remittanceId: number) =>
    downloadFile(`/remittances/${remittanceId}/file`, { filename: `remittance-${remittanceId}.txt` }),
};

export const remittanceKeys = {
  all: ['remittances'] as const,
  /** The remittance list for a status (an infinite query). */
  list: (status?: RemittanceStatus) => ['remittances', 'list', status ?? 'all'] as const,
  /** How many remittances have a status. */
  count: (status: RemittanceStatus) => ['remittances', 'count', status] as const,
  detail: (remittanceId: number) => ['remittances', 'detail', remittanceId] as const,
};
