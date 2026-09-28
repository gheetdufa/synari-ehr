import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { reportsApi, reportsKeys, type ReportPeriod } from '../../api/reports';
import { formatMoney } from '../../lib/format';
import { EmptyState, Table, Td, Th } from '../../ui/Display';
import { ReportStatus, TotalsRow } from './ReportStatus';

/** Payments received in the period, credited to the clinician who provided each service. */
export function IncomeReportView({ period }: { period: ReportPeriod }) {
  const query = useQuery({ queryKey: reportsKeys.income(period), queryFn: () => reportsApi.income(period) });
  if (!query.data) return <ReportStatus query={query} />;
  const report = query.data;
  if (report.rows.length === 0 && report.unapplied_cents === 0) {
    return (
      <EmptyState
        icon={<Receipt />}
        title="No payments in this period"
        description="Payments from clients and insurers show up here once they're received."
      />
    );
  }
  const clientTotal = report.rows.reduce((sum, row) => sum + row.client_payments_cents, 0) + report.unapplied_cents;
  const insuranceTotal = report.rows.reduce((sum, row) => sum + row.insurance_payments_cents, 0);

  return (
    <Table>
      <caption className="sr-only">Income by clinician</caption>
      <thead>
        <tr>
          <Th>Clinician</Th>
          <Th className="text-right">Client payments</Th>
          <Th className="text-right">Insurance payments</Th>
          <Th className="text-right">Total</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-sage-100">
        {report.rows.map((row) => (
          <tr key={row.clinician_id ?? 'other'}>
            <Td className="font-medium">{row.clinician_name}</Td>
            <Td className="text-right tabular-nums">{formatMoney(row.client_payments_cents)}</Td>
            <Td className="text-right tabular-nums">{formatMoney(row.insurance_payments_cents)}</Td>
            <Td className="text-right tabular-nums">{formatMoney(row.total_cents)}</Td>
          </tr>
        ))}
        {report.unapplied_cents > 0 && (
          <tr>
            <Td>
              Unapplied client credit
              <span className="block text-xs text-sage-500">Paid but not yet applied to an invoice</span>
            </Td>
            <Td className="text-right tabular-nums">{formatMoney(report.unapplied_cents)}</Td>
            <Td className="text-right text-sage-400">—</Td>
            <Td className="text-right tabular-nums">{formatMoney(report.unapplied_cents)}</Td>
          </tr>
        )}
      </tbody>
      <TotalsRow>
        <Td className="text-sage-900">Total</Td>
        <Td className="text-right tabular-nums text-sage-900">{formatMoney(clientTotal)}</Td>
        <Td className="text-right tabular-nums text-sage-900">{formatMoney(insuranceTotal)}</Td>
        <Td className="text-right tabular-nums text-sage-900">{formatMoney(report.total_cents)}</Td>
      </TotalsRow>
    </Table>
  );
}
