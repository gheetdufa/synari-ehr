import { useQuery } from '@tanstack/react-query';
import { FileStack } from 'lucide-react';
import { CLAIM_STATUS_LABELS, reportsApi, reportsKeys, type ClaimSummaryRow, type ReportPeriod } from '../../api/reports';
import { formatMoney } from '../../lib/format';
import { EmptyState, Table, Td, Th } from '../../ui/Display';
import { ReportStatus, TotalsRow } from './ReportStatus';

type MoneyColumn = 'charged_cents' | 'paid_cents' | 'adjustment_cents' | 'patient_responsibility_cents';

const MONEY_COLUMNS: { key: MoneyColumn; label: string }[] = [
  { key: 'charged_cents', label: 'Charged' },
  { key: 'paid_cents', label: 'Paid' },
  { key: 'adjustment_cents', label: 'Adjusted' },
  { key: 'patient_responsibility_cents', label: 'Patient responsibility' },
];

function total(rows: ClaimSummaryRow[], key: MoneyColumn | 'claims'): number {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

/** Insurance claims created in the period, by payer and status. */
export function ClaimsReportView({ period }: { period: ReportPeriod }) {
  const query = useQuery({ queryKey: reportsKeys.claims(period), queryFn: () => reportsApi.claims(period) });
  if (!query.data) return <ReportStatus query={query} />;
  const rows = query.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<FileStack />}
        title="No claims in this period"
        description="Insurance claims appear here once they're created for sessions, with what each payer paid and adjusted."
      />
    );
  }

  return (
    <Table>
      <caption className="sr-only">Claims by payer and status</caption>
      <thead>
        <tr>
          <Th>Payer</Th>
          <Th>Status</Th>
          <Th className="text-right">Claims</Th>
          {MONEY_COLUMNS.map((column) => (
            <Th key={column.key} className="text-right">
              {column.label}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-sage-100">
        {rows.map((row) => (
          <tr key={`${row.payer_name}-${row.status}`}>
            <Td className="font-medium">{row.payer_name}</Td>
            <Td className="whitespace-nowrap">{CLAIM_STATUS_LABELS[row.status]}</Td>
            <Td className="text-right tabular-nums">{row.claims}</Td>
            {MONEY_COLUMNS.map((column) => (
              <Td key={column.key} className="text-right tabular-nums">
                {formatMoney(row[column.key])}
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
      <TotalsRow>
        <Td className="text-sage-900">Total</Td>
        <Td />
        <Td className="text-right tabular-nums text-sage-900">{total(rows, 'claims')}</Td>
        {MONEY_COLUMNS.map((column) => (
          <Td key={column.key} className="text-right tabular-nums text-sage-900">
            {formatMoney(total(rows, column.key))}
          </Td>
        ))}
      </TotalsRow>
    </Table>
  );
}
