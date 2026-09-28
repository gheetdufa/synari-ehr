import { api, apiPage, downloadFile, type PageParams } from './client';
import type { AuditLogPage } from './practice';

export type ClientStatus = 'prospective' | 'active' | 'inactive' | 'archived';
export type BillingType = 'self_pay' | 'insurance';
/** How much of a client's record a list is for: pickers for billing forms ask for 'billing'. */
export type ClientAccessLevel = 'profile' | 'clinical' | 'billing';

export interface DiagnosisCode {
  code: string;
  description: string;
}

/** Minimal client reference embedded in other resources. */
export interface ClientRef {
  id: number;
  first_name: string;
  last_name: string;
  preferred_name: string;
}

/** A clinician on the client's care team (the primary clinician is listed first). */
export interface CareTeamMember {
  staff_id: number;
  name: string;
  is_primary: boolean;
}

export interface ClientSummary extends ClientRef {
  status: ClientStatus;
  email: string | null;
  phone: string;
  date_of_birth: string | null;
  created_at: string;
  care_team: CareTeamMember[];
}

/** Someone connected to a client: a parent or guardian, partner or emergency contact. */
export interface ClientContact {
  id: number;
  client_id: number;
  first_name: string;
  last_name: string;
  relation: string;
  email: string | null;
  phone: string;
  is_emergency_contact: boolean;
  is_guardian: boolean;
  /** Only one contact is responsible for billing; marking another one moves it. */
  responsible_for_billing: boolean;
  /** Can sign in to the client's portal with their own email (needs an email). */
  portal_access: boolean;
  portal_last_login_at: string | null;
  created_at: string;
}

export type ContactInput = Omit<ClientContact, 'id' | 'client_id' | 'portal_last_login_at' | 'created_at'>;

/** Which restricted parts of the record the signed-in staff member may open. */
export interface RecordAccess {
  clinical: boolean;
  billing: boolean;
}

export interface ClientDetail extends ClientSummary {
  pronouns: string;
  sex: string;
  gender_identity: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  time_zone: string | null;
  is_minor: boolean;
  contacts: ClientContact[];
  referral_source: string;
  /** Null when the viewer has no clinical access to this client. */
  internal_notes: string | null;
  /** Null when the viewer has neither clinical nor billing access to this client. */
  diagnosis_codes: DiagnosisCode[] | null;
  billing_type: BillingType;
  default_service_id: number | null;
  rate_override_cents: number | null;
  autopay_enabled: boolean;
  email_reminders: boolean;
  sms_reminders: boolean;
  sms_opted_out: boolean;
  portal_enabled: boolean;
  portal_messaging: boolean;
  portal_booking: boolean;
  portal_billing: boolean;
  portal_last_login_at: string | null;
  updated_at: string;
  access: RecordAccess;
}

/**
 * Fields staff can set on a client. Internal notes and diagnoses need clinical access; billing
 * type, default service, custom rate and AutoPay need billing access.
 */
export interface ClientFields {
  first_name: string;
  last_name: string;
  status: ClientStatus;
  preferred_name: string;
  pronouns: string;
  date_of_birth: string | null;
  sex: string;
  gender_identity: string;
  email: string | null;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  time_zone: string | null;
  is_minor: boolean;
  referral_source: string;
  internal_notes: string;
  diagnosis_codes: DiagnosisCode[];
  billing_type: BillingType;
  default_service_id: number | null;
  rate_override_cents: number | null;
  autopay_enabled: boolean;
  email_reminders: boolean;
  sms_reminders: boolean;
  portal_enabled: boolean;
  portal_messaging: boolean;
  portal_booking: boolean;
  portal_billing: boolean;
}

/** Fields accepted when creating a client (everything except names is optional). */
export type ClientInput = Partial<Omit<ClientFields, 'autopay_enabled'>> & {
  first_name: string;
  last_name: string;
  /** Defaults to the creator when they're a clinician; required for anyone else. */
  primary_clinician_id?: number;
  send_portal_invite?: boolean;
};

export type ClientUpdate = Partial<ClientFields>;

export interface CareTeamInput {
  primary_clinician_id: number;
  clinician_ids: number[];
}

/** X12 patient-to-subscriber relationship: 18 self, 01 spouse, 19 child, ... */
export type SubscriberRelationship = '18' | '01' | '19' | '20' | '21' | '53' | 'G8';
export type SubscriberSex = '' | 'M' | 'F' | 'U';
export type PolicyRank = 'primary' | 'secondary' | 'other';

/** An insurance company on the practice's payer list. */
export interface Payer {
  id: number;
  name: string;
  /** The clearinghouse payer ID (blank for payers billed on paper only). */
  external_id: string;
  /** X12 claim filing indicator used unless a policy overrides it (e.g. CI commercial). */
  claim_filing_indicator: string;
}

/** A prior authorization on a policy (managed from billing, read-only here). */
export interface PolicyAuthorization {
  id: number;
  number: string;
  start_date: string;
  end_date: string;
  visits_authorized: number | null;
}

export interface InsurancePolicyFields {
  payer_id: number;
  rank: PolicyRank;
  member_id: string;
  group_number: string;
  plan_name: string;
  subscriber_relationship: SubscriberRelationship;
  subscriber_first_name: string;
  subscriber_last_name: string;
  subscriber_dob: string | null;
  subscriber_sex: SubscriberSex;
  subscriber_address_line1: string;
  subscriber_address_line2: string;
  subscriber_city: string;
  subscriber_state: string;
  subscriber_postal_code: string;
  /** Blank uses the payer's claim filing indicator. */
  claim_filing_indicator: string;
  effective_date: string | null;
  termination_date: string | null;
  copay_cents: number | null;
  coinsurance_percent: number | null;
}

export interface InsurancePolicy extends InsurancePolicyFields {
  id: number;
  client_id: number;
  payer: Pick<Payer, 'id' | 'name' | 'external_id'>;
  authorizations: PolicyAuthorization[];
}

/**
 * Why a record is exported. Treatment, payment, health care operations and giving it to the client
 * aren't disclosures; "other" is, and is listed in the client's accounting of disclosures.
 */
export type ExportPurpose = 'treatment' | 'payment' | 'operations' | 'client' | 'other';

export const EXPORT_PURPOSE_LABELS: Record<ExportPurpose, string> = {
  treatment: 'Treatment',
  payment: 'Payment',
  operations: 'Health care operations',
  client: 'Giving it to the client or their representative',
  other: 'Other disclosure',
};

export interface ExportRequest {
  purpose: ExportPurpose;
  /** Required for "other": who receives it. */
  recipient_name?: string;
  recipient_address?: string;
  /** Required for "other": what is disclosed and why. */
  description?: string;
  legal_basis?: string;
}

/** Filters for the client list. `q` searches names, email and phone; `access` keeps only clients reachable at that level. */
export interface ClientListParams extends PageParams {
  q?: string;
  status?: ClientStatus;
  clinician_id?: number;
  access?: ClientAccessLevel;
}

export const clientsApi = {
  /** A page of clients by last name, with how many match in all. */
  list: (params: ClientListParams = {}) => apiPage<ClientSummary>('/clients', { query: { ...params } }),
  get: (id: number) => api<ClientDetail>(`/clients/${id}`),
  create: (input: ClientInput) => api<ClientDetail>('/clients', { body: input }),
  update: (id: number, changes: ClientUpdate) =>
    api<ClientDetail>(`/clients/${id}`, { method: 'PATCH', body: changes }),
  setCareTeam: (id: number, input: CareTeamInput) =>
    api<ClientDetail>(`/clients/${id}/care-team`, { method: 'PUT', body: input }),
  invite: (id: number) => api<{ detail: string }>(`/clients/${id}/portal-invite`, { method: 'POST' }),
  contacts: {
    create: (clientId: number, input: ContactInput) =>
      api<ClientContact>(`/clients/${clientId}/contacts`, { body: input }),
    update: (clientId: number, contactId: number, changes: Partial<ContactInput>) =>
      api<ClientContact>(`/clients/${clientId}/contacts/${contactId}`, { method: 'PATCH', body: changes }),
    remove: (clientId: number, contactId: number) =>
      api<void>(`/clients/${clientId}/contacts/${contactId}`, { method: 'DELETE' }),
    invite: (clientId: number, contactId: number) =>
      api<{ detail: string }>(`/clients/${clientId}/contacts/${contactId}/portal-invite`, { method: 'POST' }),
  },
  insurance: {
    list: (clientId: number) => api<InsurancePolicy[]>(`/clients/${clientId}/insurance`),
    create: (clientId: number, input: InsurancePolicyFields) =>
      api<InsurancePolicy>(`/clients/${clientId}/insurance`, { body: input }),
    update: (clientId: number, policyId: number, input: InsurancePolicyFields) =>
      api<InsurancePolicy>(`/clients/${clientId}/insurance/${policyId}`, { method: 'PUT', body: input }),
    remove: (clientId: number, policyId: number) =>
      api<void>(`/clients/${clientId}/insurance/${policyId}`, { method: 'DELETE' }),
  },
  /** The practice's insurance payers, for choosing one on a policy. */
  payers: () => api<Payer[]>('/insurance/payers'),
  /** Download the client's record as a zip; "other" purposes are recorded as a disclosure. */
  exportRecord: (id: number, request: ExportRequest) => downloadFile(`/clients/${id}/export`, { body: request }),
  /** Who viewed or changed this client's record, newest first. */
  accessHistory: (id: number, cursor?: number) =>
    api<AuditLogPage>(`/clients/${id}/access-history`, { query: { cursor, limit: 100 } }),
};

export const clientKeys = {
  all: ['clients'] as const,
  /** The paginated client list (an infinite query). */
  list: (params: ClientListParams) => ['clients', 'list', params] as const,
  /** A picker's search results (one small page). */
  search: (params: ClientListParams) => ['clients', 'search', params] as const,
  detail: (id: number) => ['clients', 'detail', id] as const,
  insurance: (id: number) => ['clients', 'insurance', id] as const,
  accessHistory: (id: number) => ['clients', 'access-history', id] as const,
  payers: ['insurance', 'payers'] as const,
};
