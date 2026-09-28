import { ApiError, api, apiPage, downloadFile, type PageParams } from './client';
import type { AppointmentStatus } from './appointments';
import type { ClientRef } from './clients';
import type { BillingProvider, TaxIdType } from './practice';
import { formatMoney, parseMoneyToCents } from '../lib/format';

export type InvoiceStatus = 'open' | 'paid' | 'void';
export type PaymentMethod = 'card' | 'cash' | 'check' | 'external_card' | 'other';
/** Methods staff can record by hand (card payments only come from Stripe). */
export type ManualPaymentMethod = Exclude<PaymentMethod, 'card'>;
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';

/**
 * A session (one client's part of an appointment), a change to what the client owes for a
 * session (e.g. after their insurer paid), or anything else, like a records request.
 */
export type InvoiceItemKind = 'service' | 'adjustment' | 'custom';

export interface InvoiceItem {
  id: number;
  kind: InvoiceItemKind;
  /** The session (appointment participant) a service or adjustment line is for. */
  participant_id: number | null;
  /** That session's appointment. */
  appointment_id: number | null;
  /** Plain date (YYYY-MM-DD) in the practice's time zone. */
  service_date: string;
  service_code: string;
  description: string;
  amount_cents: number;
  /** The clinician who provided the session; null and empty for custom lines. */
  clinician_id: number | null;
  clinician_name: string;
}

export interface Invoice {
  id: number;
  client: ClientRef;
  number: string;
  issued_on: string;
  due_on: string;
  status: InvoiceStatus;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  notes: string;
  /** Who the invoice is addressed to when not the client (e.g. a minor's parent). */
  bill_to_contact_id: number | null;
  bill_to_name: string;
  voided_at: string | null;
  /**
   * When the client started patient-provider dispute resolution over this bill (No Surprises
   * Act). AutoPay and automatic collection pause until it's resolved.
   */
  disputed_at: string | null;
  /** Why staff invoiced $400 or more above the client's good faith estimate (blank in the portal). */
  gfe_override_reason: string;
  /** Good faith estimate warnings, returned when the invoice is created. */
  estimate_warnings?: string[];
  created_at: string;
  items: InvoiceItem[];
}

/** A client's past billable session that isn't on an invoice yet (one per billed participant). */
export interface UninvoicedSession {
  participant_id: number;
  appointment_id: number;
  client: ClientRef;
  clinician_id: number;
  clinician_name: string;
  starts_at: string;
  ends_at: string;
  service_code: string;
  service_description: string;
  /** This client's attendance, else the session's status. */
  status: AppointmentStatus;
  /** What the invoice line will be: what the client owes (e.g. a copay), else the fee. */
  amount_cents: number;
  /** How this self-pay session compares with the client's good faith estimate ('' when fine). */
  estimate_warning: string;
}

export interface PaymentAllocation {
  invoice_id: number;
  amount_cents: number;
}

export interface Payment {
  id: number;
  client: ClientRef;
  amount_cents: number;
  method: PaymentMethod;
  status: PaymentStatus;
  refunded_cents: number;
  refundable_cents: number;
  unapplied_cents: number;
  reference: string;
  failure_reason: string;
  received_at: string | null;
  created_at: string;
  allocations: PaymentAllocation[];
}

export interface SavedCard {
  id: number;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
  created_at: string;
}

/** The practice's billing identity on a superbill. */
export interface SuperbillPractice {
  name: string;
  address_lines: string[];
  phone: string;
  tax_id: string;
  tax_id_type: TaxIdType;
  /** Group (type 2) NPI. */
  npi: string;
  taxonomy_code: string;
  billing_provider: BillingProvider;
}

/** The clinician who provided a service (the rendering provider). */
export interface SuperbillProvider {
  name: string;
  credentials: string;
  /** Individual (type 1) NPI. */
  npi: string;
  taxonomy_code: string;
  license: string;
}

/** The client's primary insurance policy; the subscriber is the policyholder. */
export interface SuperbillInsurance {
  payer_name: string;
  /** The payer's electronic payer ID, if it has one. */
  payer_id: string;
  member_id: string;
  group_number: string;
  plan_name: string;
  subscriber_name: string;
  subscriber_relationship: string;
  subscriber_dob: string | null;
}

export interface SuperbillLine {
  date: string;
  cpt: string;
  description: string;
  place_of_service: string;
  units: number;
  fee_cents: number;
  provider: SuperbillProvider;
}

/** Everything printed on a superbill, frozen when it was created. */
export interface SuperbillData {
  practice: SuperbillPractice;
  /** The one clinician who provided every service, or null when several did. */
  provider: SuperbillProvider | null;
  client: { name: string; date_of_birth: string | null; address_lines: string[]; phone: string };
  insurance: SuperbillInsurance | null;
  diagnosis_codes: { code: string; description: string }[];
  lines: SuperbillLine[];
  payments: { date: string; method: string; amount_cents: number }[];
  total_cents: number;
  paid_cents: number;
}

export interface Superbill {
  id: number;
  client_id: number;
  number: string;
  period_start: string;
  period_end: string;
  total_cents: number;
  paid_cents: number;
  data: SuperbillData;
  created_at: string;
}

export interface BillingOverview {
  outstanding_cents: number;
  collected_this_month_cents: number;
  open_invoice_count: number;
  uninvoiced_count: number;
}

export interface ClientBillingSummary {
  client_id: number;
  balance_cents: number;
  credit_cents: number;
  open_invoices: Invoice[];
  recent_payments: Payment[];
  saved_cards: SavedCard[];
  autopay_enabled: boolean;
  /** Declined AutoPay charges in a row (three turn AutoPay off). */
  autopay_failures: number;
  payments_enabled: boolean;
}

export interface PortalBillingSummary {
  balance_cents: number;
  credit_cents: number;
  payments_enabled: boolean;
  autopay_enabled: boolean;
  default_card: SavedCard | null;
}

export interface InvoiceLineInput {
  service_date: string;
  description: string;
  service_code?: string;
  amount_cents: number;
}

export interface InvoiceCreate {
  client_id: number;
  /** The client's uninvoiced sessions to bill, by participant id. */
  participant_ids: number[];
  items: InvoiceLineInput[];
  notes?: string;
  notify?: boolean;
  /** Needed when billed charges would be $400 or more above a good faith estimate. */
  gfe_override_reason?: string;
}

/** How a new invoice compares with the client's good faith estimates. */
export interface EstimateCheck {
  warnings: string[];
  /** Billed charges would be $400 or more above an estimate: a reason is needed to invoice. */
  override_required: boolean;
  over_by_cents: number;
}

/** The 409 `detail` when an invoice needs a good faith estimate override reason. */
export interface EstimateOverrideDetail {
  code: 'estimate_override_required';
  message: string;
  over_by_cents: number;
}

/** The override detail of a failed invoice creation, if that's why it failed. */
export function estimateOverrideDetail(error: unknown): EstimateOverrideDetail | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const detail = error.detail as Partial<EstimateOverrideDetail> | null;
  if (!detail || typeof detail !== 'object' || detail.code !== 'estimate_override_required') return null;
  return {
    code: 'estimate_override_required',
    message: typeof detail.message === 'string' ? detail.message : error.message,
    over_by_cents: typeof detail.over_by_cents === 'number' ? detail.over_by_cents : 0,
  };
}

export interface PaymentCreate {
  client_id: number;
  amount_cents: number;
  method: ManualPaymentMethod;
  reference?: string;
  /** Aware ISO datetime; omitted means "now". */
  received_at?: string;
  invoice_id?: number;
  send_receipt?: boolean;
}

export interface SuperbillCreate {
  client_id: number;
  period_start: string;
  period_end: string;
}

export interface CheckoutCreate {
  invoice_id?: number;
  amount_cents?: number;
  save_card?: boolean;
}

/** Stripe's smallest USD charge; the API rejects smaller card payments. */
export const MIN_CARD_CHARGE_CENTS = 50;
/** Largest single amount the API accepts ($100,000). */
export const MAX_AMOUNT_CENTS = 10_000_000;

/** Filters for the staff billing lists (invoices also filter by status). */
export interface BillingListParams extends PageParams {
  client_id?: number;
}

export interface InvoiceListParams extends BillingListParams {
  status?: InvoiceStatus;
}

export interface PaymentListParams extends BillingListParams {
  /** Only payments applied (in part) to this invoice. */
  invoice_id?: number;
}

/** The most uninvoiced sessions one request returns (the API's limit). */
export const MAX_UNINVOICED_PAGE = 500;

/**
 * Staff billing endpoints, over the clients whose billing the signed-in person sees: every
 * client with `billing_all`, their own care team's with `billing_own`. Lists are paginated.
 */
export const billingApi = {
  overview: () => api<BillingOverview>('/billing/overview'),
  /** Uninvoiced sessions by client (last name) and then date, so each client's sessions are together. */
  uninvoiced: (params: BillingListParams = {}) =>
    apiPage<UninvoicedSession>('/billing/uninvoiced', { query: { ...params } }),
  clientSummary: (clientId: number) => api<ClientBillingSummary>(`/billing/clients/${clientId}/summary`),
  /** Invoices, newest first. */
  invoices: (params: InvoiceListParams = {}) => apiPage<Invoice>('/billing/invoices', { query: { ...params } }),
  invoice: (id: number) => api<Invoice>(`/billing/invoices/${id}`),
  createInvoice: (input: InvoiceCreate) => api<Invoice>('/billing/invoices', { body: input }),
  /** Compare a would-be invoice with the client's good faith estimates (nothing is created). */
  estimateCheck: (input: InvoiceCreate) => api<EstimateCheck>('/billing/invoices/estimate-check', { body: input }),
  voidInvoice: (id: number) => api<Invoice>(`/billing/invoices/${id}/void`, { method: 'POST' }),
  /** Mark that the client disputes this bill: AutoPay and collection pause until resolved. */
  disputeInvoice: (id: number) => api<Invoice>(`/billing/invoices/${id}/dispute`, { method: 'POST' }),
  resolveDispute: (id: number) => api<Invoice>(`/billing/invoices/${id}/resolve`, { method: 'POST' }),
  downloadInvoicePdf: (id: number) => downloadFile(`/billing/invoices/${id}/pdf`),
  /** Payments, newest first. */
  payments: (params: PaymentListParams = {}) => apiPage<Payment>('/billing/payments', { query: { ...params } }),
  recordPayment: (input: PaymentCreate) => api<Payment>('/billing/payments', { body: input }),
  refund: (paymentId: number, amountCents: number) =>
    api<Payment>(`/billing/payments/${paymentId}/refund`, { body: { amount_cents: amountCents } }),
  cards: (clientId: number) => api<SavedCard[]>(`/billing/clients/${clientId}/cards`),
  makeDefaultCard: (cardId: number) => api<SavedCard>(`/billing/cards/${cardId}/default`, { method: 'POST' }),
  removeCard: (cardId: number) => api<void>(`/billing/cards/${cardId}`, { method: 'DELETE' }),
  charge: (clientId: number, input: { amount_cents: number; card_id?: number }) =>
    api<Payment>(`/billing/clients/${clientId}/charge`, { body: input }),
  /** Superbills, newest period first. */
  superbills: (params: BillingListParams = {}) => apiPage<Superbill>('/billing/superbills', { query: { ...params } }),
  createSuperbill: (input: SuperbillCreate) => api<Superbill>('/billing/superbills', { body: input }),
  downloadSuperbillPdf: (id: number) => downloadFile(`/billing/superbills/${id}/pdf`),
};

/** Client-portal billing endpoints (the signed-in client's own records). */
export const portalBillingApi = {
  summary: () => api<PortalBillingSummary>('/portal/billing/summary', { realm: 'client' }),
  invoices: () => api<Invoice[]>('/portal/billing/invoices', { realm: 'client' }),
  downloadInvoicePdf: (id: number) => downloadFile(`/portal/billing/invoices/${id}/pdf`, { realm: 'client' }),
  payments: () => api<Payment[]>('/portal/billing/payments', { realm: 'client' }),
  superbills: () => api<Superbill[]>('/portal/billing/superbills', { realm: 'client' }),
  downloadSuperbillPdf: (id: number) =>
    downloadFile(`/portal/billing/superbills/${id}/pdf`, { realm: 'client' }),
  /** Starts Stripe Checkout; the browser should go to the returned url. */
  checkout: (input: CheckoutCreate) =>
    api<{ url: string }>('/portal/billing/checkout', { realm: 'client', body: input }),
  /** Starts a Stripe Checkout page that only saves a card. */
  setupCard: () => api<{ url: string }>('/portal/billing/cards/setup', { realm: 'client', method: 'POST' }),
  cards: () => api<SavedCard[]>('/portal/billing/cards', { realm: 'client' }),
  makeDefaultCard: (cardId: number) =>
    api<SavedCard[]>(`/portal/billing/cards/${cardId}/default`, { realm: 'client', method: 'POST' }),
};

/** Query keys for staff billing; invalidate `billingKeys.all` after any billing change. */
export const billingKeys = {
  all: ['billing'] as const,
  overview: ['billing', 'overview'] as const,
  /** Every client's uninvoiced sessions (an infinite query). */
  uninvoiced: () => ['billing', 'uninvoiced', 'all'] as const,
  /** One client's uninvoiced sessions, for a new invoice. */
  clientUninvoiced: (clientId: number) => ['billing', 'uninvoiced', 'client', clientId] as const,
  clientSummary: (clientId: number) => ['billing', 'client-summary', clientId] as const,
  /** Paginated lists (infinite queries). */
  invoices: (params: InvoiceListParams) => ['billing', 'invoices', params] as const,
  payments: (params: BillingListParams) => ['billing', 'payments', params] as const,
  superbills: (params: BillingListParams) => ['billing', 'superbills', params] as const,
  invoice: (id: number) => ['billing', 'invoice', id] as const,
  /** The payments applied to an invoice. */
  invoicePayments: (invoiceId: number) => ['billing', 'invoice-payments', invoiceId] as const,
};

/** Query keys for client-portal billing. */
export const portalBillingKeys = {
  all: ['portal', 'billing'] as const,
  summary: ['portal', 'billing', 'summary'] as const,
  invoices: ['portal', 'billing', 'invoices'] as const,
  payments: ['portal', 'billing', 'payments'] as const,
  superbills: ['portal', 'billing', 'superbills'] as const,
  cards: ['portal', 'billing', 'cards'] as const,
};

// Labels and display helpers ---------------------------------------------------------------

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  card: 'Card (online)',
  cash: 'Cash',
  check: 'Check',
  external_card: 'Card (external)',
  other: 'Other',
};

export const MANUAL_PAYMENT_METHODS: ManualPaymentMethod[] = ['cash', 'check', 'external_card', 'other'];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Processing',
  succeeded: 'Received',
  failed: 'Failed',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
};

/** What an invoice's badge says: open invoices split into unpaid, partly paid and overdue. */
export type InvoiceDisplayStatus = 'open' | 'partial' | 'overdue' | 'paid' | 'void';

export const INVOICE_STATUS_LABELS: Record<InvoiceDisplayStatus, string> = {
  open: 'Open',
  partial: 'Partly paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

/** `today` is a plain YYYY-MM-DD date in the viewer's practice time zone. */
export function invoiceDisplayStatus(
  invoice: Pick<Invoice, 'status' | 'due_on' | 'paid_cents'>,
  today: string,
): InvoiceDisplayStatus {
  if (invoice.status !== 'open') return invoice.status;
  if (invoice.due_on < today) return 'overdue';
  return invoice.paid_cents > 0 ? 'partial' : 'open';
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayInZone(timeZone?: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function brandName(brand: string): string {
  const known: Record<string, string> = {
    amex: 'American Express',
    diners: 'Diners Club',
    discover: 'Discover',
    jcb: 'JCB',
    mastercard: 'Mastercard',
    unionpay: 'UnionPay',
    visa: 'Visa',
  };
  const key = brand.toLowerCase();
  if (known[key]) return known[key];
  return brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card';
}

/** "Visa •••• 4242". */
export function cardLabel(card: Pick<SavedCard, 'brand' | 'last4'>): string {
  return card.last4 ? `${brandName(card.brand)} •••• ${card.last4}` : brandName(card.brand);
}

/** "04/28". */
export function cardExpiry(card: Pick<SavedCard, 'exp_month' | 'exp_year'>): string {
  return `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year % 100).padStart(2, '0')}`;
}

/** A card is good through the last day of its expiry month. */
export function isCardExpired(card: Pick<SavedCard, 'exp_month' | 'exp_year'>, today: string): boolean {
  if (!card.exp_year || !card.exp_month) return false;
  const [year, month] = today.split('-').map(Number);
  return card.exp_year < year || (card.exp_year === year && card.exp_month < month);
}

// Amount input validation ------------------------------------------------------------------

export interface AmountRules {
  /** Smallest allowed amount in cents (inclusive). */
  min?: number;
  /** Largest allowed amount in cents (inclusive). */
  max?: number;
  minMessage?: string;
  maxMessage?: string;
}

export type AmountCheck = { cents: number; error: null } | { cents: null; error: string };

/** Parse and check a typed dollar amount. Always > $0 and within the API's limit. */
export function validateAmount(input: string, rules: AmountRules = {}): AmountCheck {
  if (!input.trim()) return { cents: null, error: 'Enter an amount.' };
  const cents = parseMoneyToCents(input);
  if (cents === null) return { cents: null, error: 'Enter a dollar amount, like 45 or 45.50.' };
  if (cents <= 0) return { cents: null, error: 'Enter an amount greater than $0.00.' };
  if (cents > MAX_AMOUNT_CENTS) {
    return { cents: null, error: `Amounts can be at most ${formatMoney(MAX_AMOUNT_CENTS)}.` };
  }
  if (rules.min !== undefined && cents < rules.min) {
    return { cents: null, error: rules.minMessage ?? `The minimum is ${formatMoney(rules.min)}.` };
  }
  if (rules.max !== undefined && cents > rules.max) {
    return { cents: null, error: rules.maxMessage ?? `The most you can enter is ${formatMoney(rules.max)}.` };
  }
  return { cents, error: null };
}

/** Cents as a plain input value ("45.50"), for prefilling amount fields. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
