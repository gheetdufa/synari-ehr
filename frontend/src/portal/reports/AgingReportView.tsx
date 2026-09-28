import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { AGING_BUCKETS, reportsApi, reportsKeys, type AgingRow } from '../../api/reports';
import { formatMoney } from '../../lib/format';
import { EmptyState, Table, Td, Th } from '../../ui/Display';
import { ReportStatus, TotalsRow } from './ReportStatus';

function amount(cents: number): string {
  return cents === 0 ? '—' : formatMoney(cents);
}

function AgingSection({
  title,
  nameHeader,
  emptyText,
  rows,
}: {
  title: string;
  nameHeader: string;
  emptyText: string;
  rows: AgingRow[];
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="border-b border-sage-100 last:border-b-0">
      <h3 id={headingId} className="px-4 pt-4 text-sm font-semibold text-sage-900 sm:px-5">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 pt-1 text-sm text-sage-500 sm:px-5">{emptyText}</p>
      ) : (
        <Table>
          <caption className="sr-only">{title}, by days outstanding</caption>
          <thead>
            <tr>
              <Th>{nameHeader}</Th>
              {AGING_BUCKETS.map((bucket) => (
                <Th key={bucket} className="text-right">
                  {bucket} days
                </Th>
              ))}
              <Th className="text-right">Total</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sage-100">
            {rows.map((row) => (
              <tr key={row.label}>
                <Td className="font-medium">{row.label}</Td>
                {AGING_BUCKETS.map((bucket) => (
                  <Td key={bucket} className="text-right tabular-nums">
                    {amount(row.buckets[bucket])}
                  </Td>
                ))}
                <Td className="text-right tabular-nums">{formatMoney(row.total_cents)}</Td>
              </tr>
            ))}
          </tbody>
          <TotalsRow>
            <Td className="text-sage-900">Total</Td>
            {AGING_BUCKETS.map((bucket) => (
              <Td key={bucket} className="text-right tabular-nums text-sage-900">
                {formatMoney(rows.reduce((sum, row) => sum + row.buckets[bucket], 0))}
              </Td>
            ))}
            <Td className="text-right tabular-nums text-sage-900">
              {formatMoney(rows.reduce((sum, row) => sum + row.total_cents, 0))}
            </Td>
          </TotalsRow>
        </Table>
      )}
    </section>
  );
}

/** What clients (open invoices) and insurers (unresolved claims) still owe, by age. */
export function AgingReportView({ asOf }: { asOf: string }) {
  const query = useQuery({ queryKey: reportsKeys.aging(asOf), queryFn: () => reportsApi.aging(asOf) });
  if (!query.data) return <ReportStatus query={query} />;
  const report = query.data;
  if (report.clients.length === 0 && report.insurance.length === 0) {
    return (
      <EmptyState
        icon={<Landmark />}
        title="Nothing outstanding"
        description="No open invoice or insurance claim balances on this date."
      />
    );
  }
  return (
    <>
      <AgingSection
        title="Owed by clients"
        nameHeader="Client"
        emptyText="No client owes anything on this date."
        rows={report.clients}
      />
      <AgingSection
        title="Owed by insurers"
        nameHeader="Payer"
        emptyText="No insurance claims are waiting on payment."
        rows={report.insurance}
      />
    </>
  );
}
