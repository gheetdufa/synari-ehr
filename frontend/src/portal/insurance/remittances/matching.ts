import type { Claim, ClaimStatus } from '../../../api/claims';
import type { Adjustment, RemittanceClaim, RemittanceDetail } from '../../../api/remittances';
import { formatMoney } from '../../../lib/format';
import { ADJUSTMENT_GROUP_LABELS, CLAIM_STATUS_LABELS, reasonDescription } from '../labels';
import { serviceDates } from '../claims/queue';

/** Claims a payer could be paying: ones it has been sent. */
const PAYABLE: readonly ClaimStatus[] = ['submitted', 'accepted', 'rejected', 'denied', 'paid'];

/**
 * Claims an unmatched payment could belong to, the ones billed for the same amount first
 * ("suggested"), each group newest first as the API lists them.
 */
export function claimCandidates(claims: Claim[], payment: RemittanceClaim): { suggested: Claim[]; others: Claim[] } {
  const payable = claims.filter((claim) => PAYABLE.includes(claim.status));
  return {
    suggested: payable.filter((claim) => claim.total_charge_cents === payment.charge_cents),
    others: payable.filter((claim) => claim.total_charge_cents !== payment.charge_cents),
  };
}

/** "SYN00DX42 · Alex Rivera · Sep 3, 2026 · $150.00 · Submitted" for a claim picker. */
export function candidateLabel(claim: Claim): string {
  return [
    claim.patient_control_number,
    claim.client_name,
    serviceDates(claim),
    formatMoney(claim.total_charge_cents),
    CLAIM_STATUS_LABELS[claim.status],
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "CO-45" plus what it means, e.g. "Contractual obligation: above the fee schedule". */
export function adjustmentText(adjustment: Adjustment): { code: string; meaning: string } {
  const group = ADJUSTMENT_GROUP_LABELS[adjustment.group_code] ?? adjustment.group_code;
  const reason = reasonDescription(adjustment.reason_code);
  return {
    code: `${adjustment.group_code}-${adjustment.reason_code}`,
    meaning: reason ? `${group}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : group,
  };
}

/** Payments that didn't match one of our claims and haven't been posted. */
export function unmatchedPayments(remittance: RemittanceDetail): RemittanceClaim[] {
  return remittance.claims.filter((payment) => payment.claim_id === null && payment.posted_at === null);
}
