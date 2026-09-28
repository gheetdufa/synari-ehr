import { useQuery } from '@tanstack/react-query';
import { CalendarCheck } from 'lucide-react';
import { reportsApi, reportsKeys, type ReportPeriod, type SessionRow } from '../../api/reports';
import { formatMoney } from '../../lib/format';
import { EmptyState, Table, Td, Th } from '../../ui/Display';
import { ReportStatus, TotalsRow } from './ReportStatus';

type CountColumn = 'sessions' | 'attended' | 'no_show' | 'late_canceled' | 'canceled' | 'upcoming';

const COUNT_COLUMNS: { key: CountColumn; label: string }[] = [
  { key: 'sessions', label: 'Sessions held' },
  { key: 'attended', label: 'Attended' },
  { key: 'no_show', label: 'No-show' },
  { key: 'late_canceled', label: 'Late canceled' },
  { key: 'canceled', label: 'Canceled' },
  { key: 'upcoming', label: 'Upcoming' },
];

function total(rows: SessionRow[], key: CountColumn | 'billed_cents'): number {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

/** Sessions held and client attendance outcomes by clinician. */
export function SessionsReportView({ period }: { period: ReportPeriod }) {
  const query = useQuery({ queryKey: reportsKeys.sessions(period), queryFn: () => reportsApi.sessions(period) });
  if (!query.data) return <ReportStatus query={query} />;
  const rows = query.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<CalendarCheck />}
        title="No sessions in this period"
        description="Appointments with clients in this period show up here with their attendance."
      />
    );
  }

  return (
    <>
      <Table>
        <caption className="sr-only">Sessions and attendance by clinician</caption>
        <thead>
          <tr>
            <Th>Clinician</Th>
            {COUNT_COLUMNS.map((column) => (
              <Th key={column.key} className="text-right">
                {column.label}
              </Th>
            ))}
            <Th className="text-right">Billed</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sage-100">
          {rows.map((row) => (
            <tr key={row.clinician_id}>
              <Td className="font-medium">{row.clinician_name}</Td>
              {COUNT_COLUMNS.map((column) => (
                <Td key={column.key} className="text-right tabular-nums">
                  {row[column.key]}
                </Td>
              ))}
              <Td className="text-right tabular-nums">{formatMoney(row.billed_cents)}</Td>
            </tr>
          ))}
        </tbody>
        <TotalsRow>
          <Td className="text-sage-900">Total</Td>
          {COUNT_COLUMNS.map((column) => (
            <Td key={column.key} className="text-right tabular-nums text-sage-900">
              {total(rows, column.key)}
            </Td>
          ))}
          <Td className="text-right tabular-nums text-sage-900">{formatMoney(total(rows, 'billed_cents'))}</Td>
        </TotalsRow>
      </Table>
      <p className="border-t border-sage-100 px-4 py-3 text-xs text-sage-500 sm:px-5">
        Sessions held count appointments where at least one client attended. Attendance counts each client, so a group
        session adds one per member. Billed is the fee for attended sessions.
      </p>
    </>
  );
}
