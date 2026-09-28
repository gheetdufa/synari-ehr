import { TZDate } from '@date-fns/tz';
import {
  MIN_CARD_CHARGE_CENTS,
  validateAmount,
  type InvoiceCreate,
  type ManualPaymentMethod,
  type PaymentCreate,
} from '../../api/billing';
import { formatMoney } from '../../lib/format';

const MAX_LINE_DESCRIPTION = 300;
const MAX_SERVICE_CODE = 20;
const MAX_NOTES = 2000;
const MAX_REFERENCE = 200;
const MAX_SUPERBILL_DAYS = 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A custom invoice line as typed in the form. */
export interface ManualLineDraft {
  key: string;
  service_date: string;
  description: string;
  service_code: string;
  amount: string;
}

export type LineErrors = Partial<Record<'service_date' | 'description' | 'service_code' | 'amount', string>>;

export interface InvoiceDraft {
  clientId: number | null;
  /** Chosen uninvoiced sessions, by participant id. */
  participantIds: number[];
  lines: ManualLineDraft[];
  notes: string;
  notify: boolean;
}

export type InvoicePayloadResult =
  | { ok: true; payload: InvoiceCreate; totalCents: number }
  | { ok: false; formError: string | null; lineErrors: Record<string, LineErrors> };

/**
 * Validate a new-invoice form and build the API body (sessions plus custom lines).
 * `amountsBySession` is what the client owes for each uninvoiced session, by participant id.
 */
export function buildInvoicePayload(
  draft: InvoiceDraft,
  amountsBySession: ReadonlyMap<number, number>,
): InvoicePayloadResult {
  const lineErrors: Record<string, LineErrors> = {};
  const items: InvoiceCreate['items'] = [];
  let totalCents = 0;

  for (const line of draft.lines) {
    const errors: LineErrors = {};
    const description = line.description.trim();
    const code = line.service_code.trim();
    if (!description) errors.description = 'Add a description.';
    else if (description.length > MAX_LINE_DESCRIPTION) errors.description = 'Keep it under 300 characters.';
    if (code.length > MAX_SERVICE_CODE) errors.service_code = 'Codes are at most 20 characters.';
    if (!ISO_DATE.test(line.service_date)) errors.service_date = 'Pick a date.';
    const amount = validateAmount(line.amount);
    if (amount.error !== null) errors.amount = amount.error;
    if (Object.keys(errors).length > 0) {
      lineErrors[line.key] = errors;
      continue;
    }
    totalCents += amount.cents ?? 0;
    items.push({
      service_date: line.service_date,
      description,
      service_code: code,
      amount_cents: amount.cents ?? 0,
    });
  }

  const participantIds = Array.from(new Set(draft.participantIds));
  for (const id of participantIds) totalCents += amountsBySession.get(id) ?? 0;

  let formError: string | null = null;
  if (draft.clientId === null) formError = 'Choose a client.';
  else if (participantIds.length === 0 && draft.lines.length === 0) {
    formError = 'Select at least one session or add a line.';
  } else if (draft.notes.length > MAX_NOTES) formError = 'Notes can be at most 2,000 characters.';

  if (formError !== null || Object.keys(lineErrors).length > 0 || draft.clientId === null) {
    return { ok: false, formError, lineErrors };
  }
  return {
    ok: true,
    totalCents,
    payload: {
      client_id: draft.clientId,
      participant_ids: participantIds,
      items,
      notes: draft.notes.trim(),
      notify: draft.notify,
    },
  };
}

export interface PaymentDraft {
  clientId: number | null;
  amount: string;
  method: ManualPaymentMethod;
  reference: string;
  /** Plain date the money was received, in the practice's time zone. */
  receivedOn: string;
  invoiceId: number | null;
  sendReceipt: boolean;
}

export type PaymentErrors = Partial<Record<'client' | 'amount' | 'reference' | 'receivedOn', string>>;

export type PaymentPayloadResult = { ok: true; payload: PaymentCreate } | { ok: false; errors: PaymentErrors };

/** Validate a record-payment form and build the API body. */
export function buildPaymentPayload(draft: PaymentDraft, today: string, timeZone: string): PaymentPayloadResult {
  const errors: PaymentErrors = {};
  if (draft.clientId === null) errors.client = 'Choose a client.';
  const amount = validateAmount(draft.amount);
  if (amount.error !== null) errors.amount = amount.error;
  if (draft.reference.trim().length > MAX_REFERENCE) errors.reference = 'Keep the reference under 200 characters.';
  if (!ISO_DATE.test(draft.receivedOn)) errors.receivedOn = 'Pick the date you received it.';
  else if (draft.receivedOn > today) errors.receivedOn = "The date can't be in the future.";
  if (Object.keys(errors).length > 0 || draft.clientId === null || amount.cents === null) {
    return { ok: false, errors };
  }
  const payload: PaymentCreate = {
    client_id: draft.clientId,
    amount_cents: amount.cents,
    method: draft.method,
    reference: draft.reference.trim(),
    send_receipt: draft.sendReceipt,
  };
  const receivedAt = receivedAtIso(draft.receivedOn, today, timeZone);
  if (receivedAt) payload.received_at = receivedAt;
  if (draft.invoiceId !== null) payload.invoice_id = draft.invoiceId;
  return { ok: true, payload };
}

/**
 * When a payment dated `date` was received: omitted for today (the server stamps "now"),
 * otherwise noon that day in the practice's time zone, as a UTC ISO string.
 */
export function receivedAtIso(date: string, today: string, timeZone: string): string | undefined {
  if (date === today) return undefined;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(new TZDate(year, month - 1, day, 12, timeZone).getTime()).toISOString();
}

/** First and last day of the month before `today` (both YYYY-MM-DD). */
export function lastMonthRange(today: string): { start: string; end: string } {
  const [year, month] = today.split('-').map(Number);
  const startYear = month === 1 ? year - 1 : year;
  const startMonth = month === 1 ? 12 : month - 1;
  const lastDay = new Date(Date.UTC(startYear, startMonth, 0)).getUTCDate();
  const mm = String(startMonth).padStart(2, '0');
  return { start: `${startYear}-${mm}-01`, end: `${startYear}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

/** Error for a superbill period, or null when it's valid (at most one year, end after start). */
export function superbillPeriodError(start: string, end: string): string | null {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return 'Pick a start and end date.';
  if (end < start) return 'The period must end on or after its start.';
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_SUPERBILL_DAYS) return 'A superbill can cover at most one year.';
  return null;
}

/** Rules for charging a saved card: at least Stripe's minimum. */
export const CARD_CHARGE_RULES = {
  min: MIN_CARD_CHARGE_CENTS,
  minMessage: `Card charges must be at least ${formatMoney(MIN_CARD_CHARGE_CENTS)}.`,
};

let lineCounter = 0;

/** A blank custom line dated `date`. */
export function newManualLine(date: string): ManualLineDraft {
  lineCounter += 1;
  return { key: `line-${lineCounter}`, service_date: date, description: '', service_code: '', amount: '' };
}
