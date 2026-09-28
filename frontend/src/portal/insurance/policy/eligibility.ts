import type { EligibilitySummary } from '../../../api/insurance';
import { formatMoney, formatPlainDate } from '../../../lib/format';

export const NOT_STATED = 'Not stated';

function yesNo(value: boolean | null, yes: string, no: string): string {
  return value === null ? NOT_STATED : value ? yes : no;
}

/** "$450.00 left of $1,000.00", or just the part the payer stated. */
function remaining(left: number | null, total: number | null): string {
  if (left !== null && total !== null) return `${formatMoney(left)} left of ${formatMoney(total)}`;
  if (left !== null) return `${formatMoney(left)} left`;
  if (total !== null) return formatMoney(total);
  return NOT_STATED;
}

function coverage(start: string | null, end: string | null): string {
  if (start && end) return `${formatPlainDate(start)} – ${formatPlainDate(end)}`;
  if (start) return `Since ${formatPlainDate(start)}`;
  if (end) return `Until ${formatPlainDate(end)}`;
  return NOT_STATED;
}

/** The benefits a payer stated, as label/value rows for display. */
export function eligibilityRows(result: EligibilitySummary): { label: string; value: string }[] {
  return [
    { label: 'Plan', value: [result.plan_name, result.group_number && `group ${result.group_number}`].filter(Boolean).join(', ') || NOT_STATED },
    { label: 'Coverage', value: coverage(result.coverage_start, result.coverage_end) },
    { label: 'In network', value: yesNo(result.in_network, 'Yes', 'No') },
    { label: 'Copay', value: result.copay_cents === null ? NOT_STATED : formatMoney(result.copay_cents) },
    {
      label: 'Coinsurance',
      value: result.coinsurance_percent === null ? NOT_STATED : `${result.coinsurance_percent}% paid by the client`,
    },
    { label: 'Deductible', value: remaining(result.deductible_remaining_cents, result.deductible_cents) },
    { label: 'Out-of-pocket maximum', value: remaining(result.out_of_pocket_remaining_cents, result.out_of_pocket_cents) },
    { label: 'Prior authorization', value: yesNo(result.prior_authorization_required, 'Required', 'Not required') },
  ];
}

/** One line for a past check: "Copay $30.00 · Coinsurance 20% · Deductible $450.00 left". */
export function eligibilityHeadline(result: EligibilitySummary): string {
  const parts: string[] = [];
  if (result.copay_cents !== null) parts.push(`Copay ${formatMoney(result.copay_cents)}`);
  if (result.coinsurance_percent !== null) parts.push(`Coinsurance ${result.coinsurance_percent}%`);
  if (result.deductible_remaining_cents !== null) parts.push(`Deductible ${formatMoney(result.deductible_remaining_cents)} left`);
  return parts.join(' · ');
}
