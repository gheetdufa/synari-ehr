import { api, downloadFile } from './client';

/** A report period: practice-local calendar days, both inclusive (YYYY-MM-DD). */
export interface ReportPeriod {
  start: string;
  end: string;
}

/** Money received from clients and insurers, attributed to the clinician who provided the service. */
export interface IncomeRow {
  /** Null for money that isn't tied to a clinician (custom invoice lines), shown as "Other". */
  clinician_id: number | null;
  clinician_name: string;
  client_payments_cents: number;
  insurance_payments_cents: number;
  total_cents: number;
}

export interface IncomeReport {
  start: string;
  end: string;
  rows: IncomeRow[];
  /** Client money received but not applied to any invoice (their credit). */
  unapplied_cents: number;
  total_cents: number;
}

/** Sessions held and client attendance outcomes for one clinician. */
export interface SessionRow {
  clinician_id: number;
  clinician_name: string;
  /** Appointments with at least one attended client. */
  sessions: number;
  /** Client attendances (a group session counts each member). */
  attended: number;
  no_show: number;
  late_canceled: number;
  canceled: number;
  upcoming: number;
  /** Fees of billable clients who attended. */
  billed_cents: number;
}

/** Age ranges (in days) of outstanding balances, oldest last. */
export const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** What one client (or insurer) owes, split by how old the balance is. */
export interface AgingRow {
  label: string;
  buckets: Record<AgingBucket, number>;
  total_cents: number;
}

export interface AgingReport {
  as_of: string;
  /** Open invoice balances, aged from the invoice date. */
  clients: AgingRow[];
  /** Unresolved claim balances, aged from submission. */
  insurance: AgingRow[];
}

export type ClaimStatus = 'draft' | 'queued' | 'submitted' | 'accepted' | 'rejected' | 'denied' | 'paid' | 'void';

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  submitted: 'Submitted',
  accepted: 'Accepted',
  rejected: 'Rejected',
  denied: 'Denied',
  paid: 'Paid',
  void: 'Void',
};

/** Claims created in a period for one payer and status. */
export interface ClaimSummaryRow {
  payer_name: string;
  status: ClaimStatus;
  claims: number;
  charged_cents: number;
  paid_cents: number;
  adjustment_cents: number;
  patient_responsibility_cents: number;
}

export type ReportId = 'income' | 'sessions' | 'aging' | 'claims';

function csvPath(report: ReportId, params: Record<string, string>): string {
  return `/reports/${report}?${new URLSearchParams({ ...params, format: 'csv' }).toString()}`;
}

/**
 * Practice reports. Staff with reports see the whole practice; clinicians with billing access
 * see their own clients. Others get a 403.
 */
export const reportsApi = {
  income: (period: ReportPeriod) => api<IncomeReport>('/reports/income', { query: { ...period } }),
  sessions: (period: ReportPeriod) => api<SessionRow[]>('/reports/sessions', { query: { ...period } }),
  aging: (asOf: string) => api<AgingReport>('/reports/aging', { query: { as_of: asOf } }),
  claims: (period: ReportPeriod) => api<ClaimSummaryRow[]>('/reports/claims', { query: { ...period } }),
  /** Download a report as CSV: a period for income, sessions and claims; a day for aging. */
  downloadCsv: (report: ReportId, params: ReportPeriod | { as_of: string }) =>
    downloadFile(csvPath(report, { ...params })),
};

export const reportsKeys = {
  all: ['reports'] as const,
  income: (period: ReportPeriod) => ['reports', 'income', period] as const,
  sessions: (period: ReportPeriod) => ['reports', 'sessions', period] as const,
  aging: (asOf: string) => ['reports', 'aging', asOf] as const,
  claims: (period: ReportPeriod) => ['reports', 'claims', period] as const,
};
