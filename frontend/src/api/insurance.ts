import { api } from './client';

/** How claims name the provider for a supervisee's session. */
export type SupervisedBilling = 'supervisor_renders' | 'supervisee_renders';

/** Claim options for the practice, plus whether a clearinghouse is connected on the server. */
export interface InsuranceSettings {
  /** Modifier added to telehealth claim lines (e.g. "95"); blank for none. */
  telehealth_modifier: string;
  supervised_billing: SupervisedBilling;
  x12_submitter_id: string;
  x12_receiver_id: string;
  x12_receiver_name: string;
  eligibility_auto_check: boolean;
  /** A Stedi API key is configured: claims can be sent electronically and eligibility checked. */
  clearinghouse_enabled: boolean;
  /** "T" while claims go to the clearinghouse as test data, "P" in production. */
  clearinghouse_usage: string;
}

export type InsuranceSettingsUpdate = Partial<Omit<InsuranceSettings, 'clearinghouse_enabled' | 'clearinghouse_usage'>>;

/** An insurance company on the practice's payer list. */
export interface Payer {
  id: number;
  name: string;
  /** The clearinghouse payer ID (blank for payers billed on paper only). */
  external_id: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  claim_filing_indicator: string;
  era_enrolled: boolean;
  notes: string;
  is_active: boolean;
}

export type PayerInput = Omit<Payer, 'id'>;

/** Support values: SUPPORTED, ENROLLMENT_REQUIRED or NOT_SUPPORTED. */
export interface PayerSearchResult {
  stedi_id: string;
  name: string;
  /** Use as the payer's external_id. */
  payer_id: string;
  aliases: string[];
  professional_claims: string;
  eligibility: string;
  remittances: string;
}

/** An insurer's approval for visits in a date range. */
export interface Authorization {
  id: number;
  policy_id: number;
  number: string;
  /** Plain dates (YYYY-MM-DD). */
  start_date: string;
  end_date: string;
  visits_authorized: number | null;
  notes: string;
  /** Service lines billed under this authorization number (claims that aren't void). */
  visits_used: number;
}

export type AuthorizationInput = Pick<Authorization, 'number' | 'start_date' | 'end_date' | 'visits_authorized' | 'notes'>;

export type EligibilityStatus = 'active' | 'inactive' | 'review' | 'error';

/** What the payer said about mental-health benefits. null = not stated. */
export interface EligibilitySummary {
  check_id: string;
  plan_name: string;
  group_number: string;
  coverage_start: string | null;
  coverage_end: string | null;
  in_network: boolean | null;
  copay_cents: number | null;
  /** The client's share, e.g. 20 for 20%. */
  coinsurance_percent: number | null;
  deductible_cents: number | null;
  deductible_remaining_cents: number | null;
  out_of_pocket_cents: number | null;
  out_of_pocket_remaining_cents: number | null;
  prior_authorization_required: boolean | null;
  messages: string[];
  /** The payer's rejection reasons. */
  errors: string[];
}

export interface EligibilityCheck {
  id: number;
  policy_id: number;
  status: EligibilityStatus;
  result: EligibilitySummary;
  /** Why the check couldn't be run (status "error"). */
  error: string;
  checked_by_id: number | null;
  created_at: string;
}

/** Claim filing indicators (the kind of insurance), most common first. */
export const CLAIM_FILING_INDICATORS: { code: string; label: string }[] = [
  { code: 'CI', label: 'Commercial insurance' },
  { code: 'BL', label: 'Blue Cross / Blue Shield' },
  { code: 'HM', label: 'HMO' },
  { code: '12', label: 'PPO' },
  { code: '13', label: 'POS' },
  { code: '14', label: 'EPO' },
  { code: 'MB', label: 'Medicare Part B' },
  { code: '16', label: 'Medicare Advantage HMO' },
  { code: 'MC', label: 'Medicaid' },
  { code: 'CH', label: 'TRICARE (CHAMPUS)' },
  { code: 'VA', label: 'Veterans Affairs' },
  { code: 'WC', label: "Workers' compensation" },
  { code: '11', label: 'Other non-federal program' },
  { code: '15', label: 'Indemnity insurance' },
  { code: '17', label: 'Dental maintenance organization' },
  { code: 'AM', label: 'Automobile medical' },
  { code: 'DS', label: 'Disability' },
  { code: 'FI', label: 'Federal Employees Program' },
  { code: 'LM', label: 'Liability medical' },
  { code: 'MA', label: 'Medicare Part A' },
  { code: 'OF', label: 'Other federal program' },
  { code: 'TV', label: 'Title V' },
  { code: 'ZZ', label: 'Mutually defined' },
];

/** Insurance setup: claim settings, the payer list, prior authorizations and eligibility checks. */
export const insuranceApi = {
  settings: () => api<InsuranceSettings>('/insurance/settings'),
  updateSettings: (changes: InsuranceSettingsUpdate) =>
    api<InsuranceSettings>('/insurance/settings', { method: 'PATCH', body: changes }),
  payers: (includeInactive = false) =>
    api<Payer[]>('/insurance/payers', { query: { include_inactive: includeInactive || undefined } }),
  createPayer: (input: PayerInput) => api<Payer>('/insurance/payers', { body: input }),
  updatePayer: (payerId: number, changes: Partial<PayerInput>) =>
    api<Payer>(`/insurance/payers/${payerId}`, { method: 'PATCH', body: changes }),
  /** Payers in the clearinghouse's network (409 when no clearinghouse is connected). */
  searchPayers: (query: string) => api<PayerSearchResult[]>('/insurance/payers/search', { query: { q: query } }),
  authorizations: (policyId: number) => api<Authorization[]>(`/insurance/policies/${policyId}/authorizations`),
  createAuthorization: (policyId: number, input: AuthorizationInput) =>
    api<Authorization>(`/insurance/policies/${policyId}/authorizations`, { body: input }),
  updateAuthorization: (policyId: number, authorizationId: number, changes: Partial<AuthorizationInput>) =>
    api<Authorization>(`/insurance/policies/${policyId}/authorizations/${authorizationId}`, {
      method: 'PATCH',
      body: changes,
    }),
  deleteAuthorization: (policyId: number, authorizationId: number) =>
    api<void>(`/insurance/policies/${policyId}/authorizations/${authorizationId}`, { method: 'DELETE' }),
  /** Past checks, newest first. */
  eligibilityChecks: (policyId: number) => api<EligibilityCheck[]>(`/insurance/policies/${policyId}/eligibility`),
  checkEligibility: (policyId: number) =>
    api<EligibilityCheck>(`/insurance/policies/${policyId}/eligibility`, { method: 'POST' }),
};

export const insuranceKeys = {
  all: ['insurance'] as const,
  settings: ['insurance', 'settings'] as const,
  payers: (includeInactive = false) => ['insurance', 'payers', { includeInactive }] as const,
  payerSearch: (query: string) => ['insurance', 'payer-search', query] as const,
  authorizations: (policyId: number) => ['insurance', 'authorizations', policyId] as const,
  eligibility: (policyId: number) => ['insurance', 'eligibility', policyId] as const,
};
