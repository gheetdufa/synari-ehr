import type { ClaimStatus, PayerResponsibility, SubmissionMethod } from '../../api/claims';
import type { EligibilityStatus } from '../../api/insurance';
import type { RemittanceStatus } from '../../api/remittances';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/** Claim statuses in the order a claim moves through them. */
export const CLAIM_STATUSES: ClaimStatus[] = ['draft', 'queued', 'submitted', 'accepted', 'rejected', 'denied', 'paid', 'void'];

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

export const CLAIM_STATUS_TONES: Record<ClaimStatus, Tone> = {
  draft: 'neutral',
  queued: 'info',
  submitted: 'info',
  accepted: 'primary',
  rejected: 'danger',
  denied: 'warning',
  paid: 'success',
  void: 'neutral',
};

/** What each status means, in a sentence. */
export const CLAIM_STATUS_HINTS: Record<ClaimStatus, string> = {
  draft: "Not sent yet. Review, fix any problems and submit.",
  queued: 'Waiting to be sent to the clearinghouse.',
  submitted: 'Sent; waiting for the payer to acknowledge it.',
  accepted: 'Accepted for processing; waiting for payment.',
  rejected: 'Returned before processing. Fix it and submit again.',
  denied: 'Processed without payment.',
  paid: 'Processed with payment.',
  void: 'Canceled.',
};

/** Draft and rejected claims can be edited and submitted. */
export const EDITABLE_CLAIM_STATUSES: readonly ClaimStatus[] = ['draft', 'rejected'];

/** Claims the payer has: correct or void them with a replacement claim. */
export const ADJUDICABLE_CLAIM_STATUSES: readonly ClaimStatus[] = ['submitted', 'accepted', 'paid', 'denied'];

export const SUBMISSION_METHOD_LABELS: Record<SubmissionMethod, string> = {
  stedi: 'Clearinghouse',
  x12_file: '837P file',
  paper: 'Paper (CMS-1500)',
};

export const RESPONSIBILITY_LABELS: Record<PayerResponsibility, string> = {
  P: 'Primary',
  S: 'Secondary',
  T: 'Tertiary',
};

/** Claim frequency codes: 1 original, 7 replacement, 8 void. */
export const FREQUENCY_LABELS: Record<string, string> = {
  '1': 'Original claim',
  '7': 'Corrected claim',
  '8': 'Void claim',
};

export const REMITTANCE_STATUS_LABELS: Record<RemittanceStatus, string> = {
  needs_review: 'Needs review',
  unposted: 'Unposted',
  posted: 'Posted',
};

export const REMITTANCE_STATUS_TONES: Record<RemittanceStatus, Tone> = {
  needs_review: 'warning',
  unposted: 'info',
  posted: 'success',
};

export const ELIGIBILITY_STATUS_LABELS: Record<EligibilityStatus, string> = {
  active: 'Active coverage',
  inactive: 'Inactive coverage',
  review: 'Needs review',
  error: "Couldn't check",
};

export const ELIGIBILITY_STATUS_TONES: Record<EligibilityStatus, Tone> = {
  active: 'success',
  inactive: 'danger',
  review: 'warning',
  error: 'neutral',
};

/** 835 payment methods. */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  ACH: 'EFT',
  CHK: 'Check',
  NON: 'No payment',
  BOP: 'Bank transfer',
  FWT: 'Wire transfer',
};

/** Claim adjustment group codes. */
export const ADJUSTMENT_GROUP_LABELS: Record<string, string> = {
  CO: 'Contractual obligation',
  PR: 'Patient responsibility',
  OA: 'Other adjustment',
  PI: 'Payer initiated reduction',
  CR: 'Correction or reversal',
};

/** The claim adjustment reason codes (CARC) mental-health practices see most. */
const REASON_CODES: Record<string, string> = {
  '1': 'Deductible',
  '2': 'Coinsurance',
  '3': 'Copay',
  '4': "Modifier doesn't match the procedure",
  '5': "Place of service doesn't match the procedure",
  '11': "Diagnosis doesn't match the procedure",
  '16': 'Missing or invalid information',
  '18': 'Duplicate claim or service',
  '22': 'Another payer may cover this',
  '23': "Adjusted for the other payer's payment",
  '26': 'Service before coverage started',
  '27': 'Service after coverage ended',
  '29': 'Filed too late',
  '31': "Patient isn't identified as insured",
  '45': 'Above the fee schedule or contracted rate',
  '50': 'Not considered medically necessary',
  '59': 'Multiple procedure rules',
  '96': 'Non-covered charge',
  '97': 'Included in another service',
  '109': "Not covered by this payer; send to the right payer",
  '119': 'Benefit maximum reached',
  '151': "Frequency isn't supported",
  '170': "Not paid for this provider type",
  '185': "Rendering provider isn't eligible",
  '197': 'Prior authorization missing',
  '204': "Not covered under the client's plan",
  '227': "Requested information wasn't provided",
  '242': 'Out-of-network provider',
  '253': 'Sequestration reduction',
};

/** "Deductible" for 1, or "" for a code not listed here. */
export function reasonDescription(reasonCode: string): string {
  return REASON_CODES[reasonCode] ?? '';
}

/** Provider-level (PLB) adjustment reasons. */
const PROVIDER_ADJUSTMENT_REASONS: Record<string, string> = {
  WO: 'Overpayment recovery',
  L6: 'Interest',
  FB: 'Forwarding balance',
  CS: 'Adjustment',
  '72': 'Authorized return',
  J1: 'Non-reimbursable',
  IR: 'Tax withholding',
  LS: 'Lump sum',
};

export function providerAdjustmentDescription(reasonCode: string): string {
  return PROVIDER_ADJUSTMENT_REASONS[reasonCode] ?? '';
}

export const CLAIM_EVENT_LABELS: Record<string, string> = {
  created: 'Created',
  updated: 'Edited',
  queued: 'Queued',
  submitted: 'Submitted',
  accepted: 'Accepted',
  rejected: 'Rejected',
  file_accepted: 'File accepted',
  paid: 'Paid',
  denied: 'Denied',
  reversed: 'Payment reversed',
  corrected: 'Corrected',
  void_requested: 'Void requested',
  voided: 'Voided',
  secondary_created: 'Secondary claim created',
};

export const CLAIM_EVENT_TONES: Record<string, Tone> = {
  accepted: 'primary',
  file_accepted: 'primary',
  rejected: 'danger',
  denied: 'warning',
  paid: 'success',
  reversed: 'warning',
};

/** Clearinghouse support values for a payer's transactions. */
export const PAYER_SUPPORT_LABELS: Record<string, string> = {
  SUPPORTED: 'Supported',
  ENROLLMENT_REQUIRED: 'Enrollment required',
  NOT_SUPPORTED: 'Not supported',
};

/** Telehealth modifiers payers commonly ask for. */
export const TELEHEALTH_MODIFIERS: { code: string; label: string }[] = [
  { code: '', label: 'None' },
  { code: '95', label: '95 · Synchronous telehealth (most payers)' },
  { code: 'GT', label: 'GT · Interactive audio and video (some Medicaid plans)' },
  { code: 'FQ', label: 'FQ · Audio-only (Medicare)' },
  { code: '93', label: '93 · Audio-only (commercial payers)' },
];

/** CMS-1500 box 21 labels diagnoses A–L; claim pointers are their 1-based positions. */
export function pointerLetter(pointer: number): string {
  return String.fromCharCode(64 + pointer);
}

/** ICD-10 codes are stored without the dot ("F411"); show them the usual way ("F41.1"). */
export function formatDiagnosisCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code;
}
