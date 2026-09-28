import type { ClaimStatus } from '../../api/claims';
import type { EligibilityStatus } from '../../api/insurance';
import type { RemittanceStatus } from '../../api/remittances';
import { Badge } from '../../ui/Display';
import {
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_TONES,
  ELIGIBILITY_STATUS_LABELS,
  ELIGIBILITY_STATUS_TONES,
  REMITTANCE_STATUS_LABELS,
  REMITTANCE_STATUS_TONES,
} from './labels';

export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  return <Badge tone={CLAIM_STATUS_TONES[status]}>{CLAIM_STATUS_LABELS[status]}</Badge>;
}

export function RemittanceStatusBadge({ status }: { status: RemittanceStatus }) {
  return <Badge tone={REMITTANCE_STATUS_TONES[status]}>{REMITTANCE_STATUS_LABELS[status]}</Badge>;
}

export function EligibilityBadge({ status }: { status: EligibilityStatus }) {
  return <Badge tone={ELIGIBILITY_STATUS_TONES[status]}>{ELIGIBILITY_STATUS_LABELS[status]}</Badge>;
}
