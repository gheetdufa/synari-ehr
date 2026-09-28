import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileStack, Send } from 'lucide-react';
import {
  claimsApi,
  claimsKeys,
  type ClaimFilters,
  type ClaimStatus,
  type ClaimStatusSummary,
} from '../../../api/claims';
import { formatMoney } from '../../../lib/format';
import { usePagedQuery } from '../../../lib/paging';
import { Button } from '../../../ui/Button';
import { EmptyState, ErrorState, Table, Td, Th } from '../../../ui/Display';
import { LoadMore } from '../../../ui/LoadMore';
import { SectionSpinner } from '../../../ui/Spinner';
import { ClaimStatusBadge } from '../Badges';
import { CLAIM_STATUSES, CLAIM_STATUS_HINTS, CLAIM_STATUS_LABELS, EDITABLE_CLAIM_STATUSES, RESPONSIBILITY_LABELS } from '../labels';
import { serviceDates } from './queue';
import { SubmitClaimsDialog } from './SubmitClaimsDialog';

export type StatusFilter = ClaimStatus | 'all';

function Total({ label, cents }: { label: string; cents: number }) {
  return (
    <div>
      <dt className="text-xs text-sage-500">{label}</dt>
      <dd className="font-semibold tabular-nums text-sage-900">{formatMoney(cents)}</dd>
    </div>
  );
}

interface StatusOption {
  id: StatusFilter;
  label: string;
  count: number;
}

/** Status filter chips (the page's tabs switch between the queue and the claims). */
function StatusChips({
  options,
  value,
  onChange,
}: {
  options: StatusOption[];
  value: StatusFilter;
  onChange: (status: StatusFilter) => void;
}) {
  return (
    <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
            option.id === value
              ? 'border-primary-600 bg-primary-600 text-white'
              : 'border-sage-200 bg-white text-sage-700 hover:bg-sage-50'
          }`}
        >
          {option.label}
          <span className={`ml-1.5 tabular-nums ${option.id === value ? 'text-primary-100' : 'text-sage-500'}`}>
            {option.count}
          </span>
        </button>
      ))}
    </div>
  );
}

const NO_CLAIMS: Omit<ClaimStatusSummary, 'status'> = {
  claims: 0,
  charged_cents: 0,
  paid_cents: 0,
  patient_responsibility_cents: 0,
  insurance_balance_cents: 0,
};

/** Add up summary rows. */
function sumSummaries(rows: ClaimStatusSummary[]): Omit<ClaimStatusSummary, 'status'> {
  return rows.reduce(
    (total, row) => ({
      claims: total.claims + row.claims,
      charged_cents: total.charged_cents + row.charged_cents,
      paid_cents: total.paid_cents + row.paid_cents,
      patient_responsibility_cents: total.patient_responsibility_cents + row.patient_responsibility_cents,
      insurance_balance_cents: total.insurance_balance_cents + row.insurance_balance_cents,
    }),
    NO_CLAIMS,
  );
}

/** Claims by status with totals; draft and rejected claims can be submitted in bulk. */
export function ClaimsList({
  filters,
  status,
  onStatusChange,
}: {
  filters: ClaimFilters;
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
}) {
  const params = { ...filters, status: status === 'all' ? undefined : status };
  const claims = usePagedQuery({
    queryKey: claimsKeys.list(params),
    fetchPage: (page) => claimsApi.list({ ...params, ...page }),
  });
  const summary = useQuery({ queryKey: claimsKeys.summary(filters), queryFn: () => claimsApi.summary(filters) });
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [submitting, setSubmitting] = useState<number[] | null>(null);

  if (claims.isPending || summary.isPending) return <SectionSpinner />;
  if (claims.isError && !claims.data) return <ErrorState error={claims.error} onRetry={() => void claims.refetch()} />;
  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;

  const rows = summary.data;
  const statusOptions: StatusOption[] = [
    { id: 'all', label: 'All', count: sumSummaries(rows).claims },
    ...CLAIM_STATUSES.map((id) => ({
      id,
      label: CLAIM_STATUS_LABELS[id],
      count: rows.find((row) => row.status === id)?.claims ?? 0,
    })),
  ];
  const shown = claims.items;
  // Void claims don't count toward money totals unless you're looking at them.
  const totals =
    status === 'all'
      ? { ...sumSummaries(rows.filter((row) => row.status !== 'void')), claims: sumSummaries(rows).claims }
      : sumSummaries(rows.filter((row) => row.status === status));
  const submittable = shown.filter((claim) => EDITABLE_CLAIM_STATUSES.includes(claim.status));
  const chosen = submittable.filter((claim) => selected.has(claim.id)).map((claim) => claim.id);

  const toggle = (ids: number[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  return (
    <div>
      <div className="px-4 pt-3 sm:px-5">
        <StatusChips options={statusOptions} value={status} onChange={onStatusChange} />
      </div>
      {status !== 'all' && <p className="px-4 pt-3 text-sm text-sage-600 sm:px-5">{CLAIM_STATUS_HINTS[status]}</p>}
      {shown.length === 0 ? (
        <EmptyState
          icon={<FileStack />}
          title={status === 'all' ? 'No claims yet' : `No ${CLAIM_STATUS_LABELS[status].toLowerCase()} claims`}
          description={status === 'all' ? 'Create claims from the sessions ready to file.' : undefined}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
            <dl aria-label="Claim totals" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-sage-500">Claims</dt>
                <dd className="font-semibold tabular-nums text-sage-900">{totals.claims.toLocaleString()}</dd>
              </div>
              <Total label="Billed" cents={totals.charged_cents} />
              <Total label="Insurance paid" cents={totals.paid_cents} />
              <Total label="Client responsibility" cents={totals.patient_responsibility_cents} />
              <Total label="Insurance balance" cents={totals.insurance_balance_cents} />
            </dl>
            {submittable.length > 0 && (
              <Button icon={<Send className="h-4 w-4" />} disabled={chosen.length === 0} onClick={() => setSubmitting(chosen)}>
                {chosen.length > 0 ? `Submit ${chosen.length} selected` : 'Submit selected'}
              </Button>
            )}
          </div>
          <Table>
            <thead className="bg-sage-50/60">
              <tr>
                <Th className="w-8">
                  {submittable.length > 0 && (
                    <input
                      type="checkbox"
                      aria-label="Select all draft and rejected claims"
                      checked={chosen.length === submittable.length}
                      onChange={(event) => toggle(submittable.map((claim) => claim.id), event.target.checked)}
                      className="h-4 w-4 rounded border-sage-300 accent-primary-600"
                    />
                  )}
                </Th>
                <Th>Claim</Th>
                <Th>Client</Th>
                <Th className="hidden md:table-cell">Payer</Th>
                <Th className="hidden lg:table-cell">Dates of service</Th>
                <Th className="text-right">Billed</Th>
                <Th className="hidden text-right sm:table-cell">Paid</Th>
                <Th className="text-right">Balance</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sage-100">
              {shown.map((claim) => (
                <tr key={claim.id} className="hover:bg-sage-50/60">
                  <Td>
                    {EDITABLE_CLAIM_STATUSES.includes(claim.status) && (
                      <input
                        type="checkbox"
                        aria-label={`Select claim ${claim.patient_control_number}`}
                        checked={selected.has(claim.id)}
                        onChange={(event) => toggle([claim.id], event.target.checked)}
                        className="h-4 w-4 rounded border-sage-300 accent-primary-600"
                      />
                    )}
                  </Td>
                  <Td>
                    <Link
                      to={`/portal/billing/claims/${claim.id}`}
                      className="font-medium text-primary-700 hover:underline"
                    >
                      {claim.patient_control_number}
                    </Link>
                    {claim.payer_responsibility !== 'P' && (
                      <p className="text-xs text-sage-500">{RESPONSIBILITY_LABELS[claim.payer_responsibility]}</p>
                    )}
                  </Td>
                  <Td>
                    <p className="text-sage-900">{claim.client_name}</p>
                    <p className="text-xs text-sage-500">{claim.rendering_clinician_name}</p>
                  </Td>
                  <Td className="hidden md:table-cell">{claim.payer_name}</Td>
                  <Td className="hidden whitespace-nowrap lg:table-cell">{serviceDates(claim)}</Td>
                  <Td className="text-right tabular-nums">{formatMoney(claim.total_charge_cents)}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">{formatMoney(claim.paid_cents)}</Td>
                  <Td className="text-right tabular-nums">{formatMoney(claim.insurance_balance_cents)}</Td>
                  <Td>
                    <ClaimStatusBadge status={claim.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <LoadMore noun="claims" {...claims.loadMore} />
        </>
      )}
      {submitting && (
        <SubmitClaimsDialog claimIds={submitting} onClose={() => setSubmitting(null)} />
      )}
    </div>
  );
}
