import type {
  Estimate,
  EstimateDelivery,
  EstimateDiagnosis,
  EstimateDraftInput,
  EstimateReason,
  EstimateStatus,
} from '../../api/estimates';
import { formatMoney, parseMoneyToCents } from '../../lib/format';

/** Diagnoses on an estimate are lettered A to L; items point at them by letter. */
export const DIAGNOSIS_LETTERS = 'ABCDEFGHIJKL';
export const MAX_DIAGNOSES = DIAGNOSIS_LETTERS.length;
export const MAX_ITEMS = 50;
export const MAX_QUANTITY = 400;
export const MAX_UNIT_FEE_CENTS = 10_000_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ESTIMATE_STATUS_LABELS: Record<EstimateStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  superseded: 'Replaced',
  void: 'Void',
};

export const ESTIMATE_STATUS_TONES: Record<EstimateStatus, 'info' | 'success' | 'neutral' | 'danger'> = {
  draft: 'info',
  issued: 'success',
  superseded: 'neutral',
  void: 'danger',
};

export const ESTIMATE_REASON_LABELS: Record<EstimateReason, string> = {
  scheduling: 'Session scheduled',
  request: 'Client asked for one',
  update: 'Update needed',
  manual: 'Started by staff',
};

export const DELIVERY_LABELS: Record<EstimateDelivery, string> = {
  portal: 'Client portal',
  email: 'Email with a portal link',
  paper: 'Paper, in person',
  mail: 'Mailed',
};

export const DELIVERY_METHODS: EstimateDelivery[] = ['portal', 'email', 'paper', 'mail'];

/** Common ways care repeats, offered as suggestions in the frequency field. */
export const FREQUENCY_SUGGESTIONS = ['Weekly', 'Every other week', 'Twice a week', 'Monthly', 'One time'];

/** "A" for the first diagnosis, "B" for the second... */
export function diagnosisLetter(index: number): string {
  return DIAGNOSIS_LETTERS[index] ?? '?';
}

export function itemTotalCents(unitFeeCents: number, quantity: number): number {
  return unitFeeCents * quantity;
}

function parseDate(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

function formatIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A plain date moved by whole days. */
export function addDays(day: string, days: number): string {
  const date = parseDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return formatIso(date);
}

/** The last day an estimate starting on `start` may cover: 12 months, less a day. */
export function maxPeriodEnd(start: string): string {
  const date = parseDate(start);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  date.setUTCDate(date.getUTCDate() - 1);
  return formatIso(date);
}

// The draft form ---------------------------------------------------------------------------

let nextKey = 1;
function newKey(prefix: string): string {
  nextKey += 1;
  return `${prefix}-${nextKey}`;
}

/** One expected service as typed in the form. Diagnoses are referenced by code, not letter. */
export interface ItemDraft {
  key: string;
  description: string;
  service_code: string;
  location: string;
  diagnosis_codes: string[];
  unit_fee: string;
  quantity: string;
  frequency: string;
}

export interface SeparateDraft {
  key: string;
  description: string;
  provider: string;
  note: string;
}

export interface EstimateForm {
  clinician_id: string;
  primary_service: string;
  period_start: string;
  period_end: string;
  scheduled_dates: string[];
  /** Chosen diagnoses, by code, in the order they're lettered. */
  diagnoses: string[];
  items: ItemDraft[];
  separately: SeparateDraft[];
  notes: string;
  change_summary: string;
  due_on: string;
}

export function newItem(changes: Partial<ItemDraft> = {}): ItemDraft {
  return {
    key: newKey('item'),
    description: '',
    service_code: '',
    location: '',
    diagnosis_codes: [],
    unit_fee: '',
    quantity: '1',
    frequency: '',
    ...changes,
  };
}

export function newSeparate(): SeparateDraft {
  return { key: newKey('separate'), description: '', provider: '', note: '' };
}

/** A blank estimate for a clinician, covering the next 12 months from `today`. */
export function emptyForm(today: string, clinicianId: number | null): EstimateForm {
  return {
    clinician_id: clinicianId === null ? '' : String(clinicianId),
    primary_service: '',
    period_start: today,
    period_end: maxPeriodEnd(today),
    scheduled_dates: [],
    diagnoses: [],
    items: [],
    separately: [],
    notes: '',
    change_summary: '',
    due_on: '',
  };
}

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** The form for a saved draft or a suggested one (letters become diagnosis codes). */
export function formFromDraft(draft: EstimateDraftInput): EstimateForm {
  const codes = draft.diagnosis_codes.map((diagnosis) => diagnosis.code);
  return {
    clinician_id: String(draft.clinician_id),
    primary_service: draft.primary_service,
    period_start: draft.period_start,
    period_end: draft.period_end,
    scheduled_dates: [...draft.scheduled_dates],
    diagnoses: codes,
    items: draft.items.map((item) =>
      newItem({
        description: item.description,
        service_code: item.service_code,
        location: item.location,
        diagnosis_codes: item.diagnosis_pointers
          .map((letter) => codes[DIAGNOSIS_LETTERS.indexOf(letter)])
          .filter((code): code is string => Boolean(code)),
        unit_fee: centsToInput(item.unit_fee_cents),
        quantity: String(item.quantity),
        frequency: item.frequency,
      }),
    ),
    separately: draft.separately_scheduled.map((entry) => ({ ...newSeparate(), ...entry })),
    notes: draft.notes,
    change_summary: draft.change_summary,
    due_on: draft.due_on ?? '',
  };
}

/** The editable fields of a saved estimate. */
export function draftOf(estimate: Estimate): EstimateDraftInput {
  return {
    clinician_id: estimate.clinician_id,
    period_start: estimate.period_start,
    period_end: estimate.period_end,
    primary_service: estimate.primary_service,
    scheduled_dates: estimate.scheduled_dates,
    diagnosis_codes: estimate.diagnosis_codes,
    items: estimate.items.map((item) => ({
      description: item.description,
      service_code: item.service_code,
      location: item.location,
      diagnosis_pointers: item.diagnosis_pointers,
      unit_fee_cents: item.unit_fee_cents,
      quantity: item.quantity,
      frequency: item.frequency,
    })),
    separately_scheduled: estimate.separately_scheduled,
    notes: estimate.notes,
    change_summary: estimate.change_summary,
    due_on: estimate.due_on,
  };
}

/** Diagnoses to choose from: the client's, plus any already on the estimate. */
export function diagnosisChoices(clientDiagnoses: EstimateDiagnosis[], onEstimate: EstimateDiagnosis[] = []): EstimateDiagnosis[] {
  const byCode = new Map<string, EstimateDiagnosis>();
  for (const diagnosis of [...clientDiagnoses, ...onEstimate]) {
    if (!byCode.has(diagnosis.code)) byCode.set(diagnosis.code, diagnosis);
  }
  return Array.from(byCode.values());
}

function quantityOf(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const quantity = Number(value.trim());
  return quantity >= 1 && quantity <= MAX_QUANTITY ? quantity : null;
}

function feeOf(value: string): number | null {
  if (!value.trim()) return null;
  const cents = parseMoneyToCents(value);
  return cents !== null && cents <= MAX_UNIT_FEE_CENTS ? cents : null;
}

/** The estimated total of what's typed so far (invalid lines count as $0). */
export function formTotalCents(form: Pick<EstimateForm, 'items'>): number {
  return form.items.reduce((sum, item) => sum + itemTotalCents(feeOf(item.unit_fee) ?? 0, quantityOf(item.quantity) ?? 0), 0);
}

export type ItemErrors = Partial<Record<'description' | 'service_code' | 'unit_fee' | 'quantity', string>>;

export interface FormErrors {
  clinician_id?: string;
  primary_service?: string;
  period_start?: string;
  period_end?: string;
  diagnoses?: string;
  scheduled_dates?: string;
  items: Record<string, ItemErrors>;
  separately: Record<string, string>;
}

export type DraftResult = { ok: true; payload: EstimateDraftInput } | { ok: false; errors: FormErrors };

export function hasErrors(errors: FormErrors): boolean {
  const { items, separately, ...rest } = errors;
  return Object.values(rest).some(Boolean) || Object.keys(items).length > 0 || Object.keys(separately).length > 0;
}

/** Validate the form (the same rules the API applies) and build the request body. */
export function buildDraftPayload(form: EstimateForm, choices: EstimateDiagnosis[]): DraftResult {
  const errors: FormErrors = { items: {}, separately: {} };
  const clinicianId = Number(form.clinician_id);
  if (!form.clinician_id || !Number.isInteger(clinicianId)) errors.clinician_id = 'Choose the clinician.';
  const primary = form.primary_service.trim();
  if (!primary) errors.primary_service = 'Describe the main service, e.g. "Individual therapy, 53 minutes".';
  else if (primary.length > 300) errors.primary_service = 'Keep it under 300 characters.';
  if (!ISO_DATE.test(form.period_start)) errors.period_start = 'Pick the first day the estimate covers.';
  if (!ISO_DATE.test(form.period_end)) errors.period_end = 'Pick the last day the estimate covers.';
  else if (!errors.period_start) {
    if (form.period_end < form.period_start) errors.period_end = "The period can't end before it starts.";
    else if (form.period_end > maxPeriodEnd(form.period_start)) errors.period_end = 'An estimate can cover at most 12 months.';
  }
  if (form.diagnoses.length > MAX_DIAGNOSES) errors.diagnoses = `Choose at most ${MAX_DIAGNOSES} diagnoses.`;
  if (form.scheduled_dates.some((day) => !ISO_DATE.test(day))) errors.scheduled_dates = 'Pick a date for each scheduled session.';
  if (form.items.length > MAX_ITEMS) errors.primary_service ??= `An estimate can list at most ${MAX_ITEMS} services.`;

  const letters = new Map(form.diagnoses.map((code, index) => [code, diagnosisLetter(index)]));
  const items: EstimateDraftInput['items'] = [];
  for (const item of form.items) {
    const itemErrors: ItemErrors = {};
    const description = item.description.trim();
    if (!description) itemErrors.description = 'Describe the service.';
    else if (description.length > 300) itemErrors.description = 'Keep it under 300 characters.';
    if (item.service_code.trim().length > 20) itemErrors.service_code = 'Codes are at most 20 characters.';
    const fee = feeOf(item.unit_fee);
    if (fee === null) itemErrors.unit_fee = 'Enter the fee per session, like 150 or 0 for no charge.';
    const quantity = quantityOf(item.quantity);
    if (quantity === null) itemErrors.quantity = `Enter a whole number from 1 to ${MAX_QUANTITY}.`;
    if (Object.keys(itemErrors).length > 0) {
      errors.items[item.key] = itemErrors;
      continue;
    }
    items.push({
      description,
      service_code: item.service_code.trim(),
      location: item.location.trim(),
      diagnosis_pointers: item.diagnosis_codes
        .map((code) => letters.get(code))
        .filter((letter): letter is string => Boolean(letter)),
      unit_fee_cents: fee ?? 0,
      quantity: quantity ?? 1,
      frequency: item.frequency.trim(),
    });
  }
  const separately = [];
  for (const entry of form.separately) {
    const description = entry.description.trim();
    if (!description) {
      errors.separately[entry.key] = 'Describe the item or service.';
      continue;
    }
    separately.push({ description, provider: entry.provider.trim(), note: entry.note.trim() });
  }
  if (hasErrors(errors)) return { ok: false, errors };

  const byCode = new Map(choices.map((diagnosis) => [diagnosis.code, diagnosis]));
  return {
    ok: true,
    payload: {
      clinician_id: clinicianId,
      period_start: form.period_start,
      period_end: form.period_end,
      primary_service: primary,
      scheduled_dates: Array.from(new Set(form.scheduled_dates)).sort(),
      diagnosis_codes: form.diagnoses.map((code) => byCode.get(code) ?? { code, description: '' }),
      items,
      separately_scheduled: separately,
      notes: form.notes.trim(),
      change_summary: form.change_summary.trim(),
      due_on: form.due_on || null,
    },
  };
}

// Issuing ----------------------------------------------------------------------------------

/** Shown when a replacement is issued without saying what changed. */
export const CHANGE_SUMMARY_REQUIRED ='Describe what changed from the estimate this one replaces.';

/**
 * What stops a draft from being issued, in plain language (empty when it's ready). A replacement's
 * change summary isn't listed: the issue dialog asks for it. Missing provider details come from
 * the server as phrases that say where to add them.
 */
export function issueProblems(estimate: Estimate, missingClientFields: string[]): string[] {
  const problems: string[] = [];
  if (estimate.items.length === 0) problems.push('Add at least one service with its expected charge.');
  if (estimate.period_end > maxPeriodEnd(estimate.period_start)) problems.push('Shorten the period to 12 months or less.');
  for (const field of missingClientFields) problems.push(`Add the client's ${field} to their profile.`);
  for (const field of estimate.missing_provider_fields) problems.push(`Add ${field}.`);
  return problems;
}

/** Whether this person may change an estimate: billing access to the client, or it's their own. */
export function canChangeEstimate(estimate: Pick<Estimate, 'clinician_id'>, who: { billing: boolean; staffId: number }): boolean {
  return who.billing || estimate.clinician_id === who.staffId;
}

/** An estimate's total, or "No charge" for a no-cost estimate. */
export function totalLabel(cents: number): string {
  return cents === 0 ? 'No charge' : formatMoney(cents);
}
