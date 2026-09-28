import { AlertTriangle, CalendarCheck, FilePlus2 } from 'lucide-react';
import { STATUS_LABELS } from '../../../api/appointments';
import { billingApi, billingKeys, type UninvoicedSession } from '../../../api/billing';
import type { ClientRef } from '../../../api/clients';
import { formatDate, formatMoney, fullName } from '../../../lib/format';
import { usePagedQuery } from '../../../lib/paging';
import { Button } from '../../../ui/Button';
import { Badge, EmptyState, ErrorState } from '../../../ui/Display';
import { LoadMore } from '../../../ui/LoadMore';
import { SectionSpinner } from '../../../ui/Spinner';
import type { BillingDialog } from '../BillingDialogs';
import { useBillingScope, usePracticeDay } from '../hooks';

interface ClientGroup {
  client: ClientRef;
  sessions: UninvoicedSession[];
  totalCents: number;
}

/** Sessions loaded per page; the API sends each client's sessions together, by client name. */
const PAGE_SIZE = 100;

/** Uninvoiced sessions by client (invoices are per client), in the order the API lists them. */
function groupByClient(sessions: UninvoicedSession[]): ClientGroup[] {
  const groups = new Map<number, ClientGroup>();
  for (const session of sessions) {
    const group = groups.get(session.client.id) ?? { client: session.client, sessions: [], totalCents: 0 };
    group.sessions.push(session);
    group.totalCents += session.amount_cents;
    groups.set(session.client.id, group);
  }
  return Array.from(groups.values());
}

function SessionStatus({ session }: { session: UninvoicedSession }) {
  if (session.status === 'attended') return null;
  return <Badge tone="warning">{STATUS_LABELS[session.status]}</Badge>;
}

/** How the session compares with the client's good faith estimate, when that needs a look. */
function EstimateWarning({ session }: { session: UninvoicedSession }) {
  if (!session.estimate_warning) return null;
  return (
    <span className="mt-0.5 flex items-start gap-1 text-xs text-amber-800">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="whitespace-normal">{session.estimate_warning}</span>
    </span>
  );
}

function sessionService(session: UninvoicedSession): string {
  return [session.service_code, session.service_description || 'Session'].filter(Boolean).join(' ');
}

/** One client's uninvoiced sessions: a table on wide screens, a list on phones. */
function ClientSessions({ group, timeZone }: { group: ClientGroup; timeZone: string }) {
  const label = `Uninvoiced sessions for ${fullName(group.client)}`;
  return (
    <>
      <table className="mt-3 hidden w-full table-fixed text-sm md:table" aria-label={label}>
        <colgroup>
          <col className="w-36" />
          <col className="w-48" />
          <col />
          <col className="w-28" />
          <col className="w-24" />
        </colgroup>
        <thead>
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-sage-500">
            <th scope="col" className="py-1.5 pr-3 font-semibold">Date</th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">Clinician</th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">Service</th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              <span className="sr-only">Attendance</span>
            </th>
            <th scope="col" className="py-1.5 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sage-50">
          {group.sessions.map((session) => (
            <tr key={session.participant_id}>
              <td className="whitespace-nowrap py-1.5 pr-3 text-sage-800">
                {formatDate(session.starts_at, timeZone, { weekday: 'short' })}
              </td>
              <td className="truncate py-1.5 pr-3 text-sage-800">{session.clinician_name}</td>
              <td className="py-1.5 pr-3 text-sage-700">
                <span className="block truncate">{sessionService(session)}</span>
                <EstimateWarning session={session} />
              </td>
              <td className="py-1.5 pr-3">
                <SessionStatus session={session} />
              </td>
              <td className="py-1.5 text-right tabular-nums text-sage-900">{formatMoney(session.amount_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-2 space-y-2 md:hidden" aria-label={label}>
        {group.sessions.map((session) => (
          <li key={session.participant_id} className="text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sage-900">{formatDate(session.starts_at, timeZone, { weekday: 'short' })}</span>
              <span className="tabular-nums text-sage-900">{formatMoney(session.amount_cents)}</span>
            </div>
            <p className="text-sage-600">
              {session.clinician_name} · {sessionService(session)}
            </p>
            <SessionStatus session={session} />
            <EstimateWarning session={session} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** Past billable sessions that aren't on an invoice, one row per billed client, grouped by client. */
export function UninvoicedTab({ openDialog }: { openDialog: (dialog: BillingDialog) => void }) {
  const { timeZone } = usePracticeDay();
  const scope = useBillingScope();
  const uninvoiced = usePagedQuery({
    queryKey: billingKeys.uninvoiced(),
    fetchPage: (page) => billingApi.uninvoiced(page),
    pageSize: PAGE_SIZE,
  });
  const groups = groupByClient(uninvoiced.items);

  if (uninvoiced.isLoading) return <SectionSpinner />;
  if (uninvoiced.isError && !uninvoiced.data) return <ErrorState error={uninvoiced.error} onRetry={() => uninvoiced.refetch()} />;
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<CalendarCheck />}
        title="Everything is invoiced"
        description={`Sessions ${scope === 'own' ? 'with your clients ' : ''}are invoiced automatically the day after they happen. Anything left over, like sessions from a voided invoice, shows up here.`}
      />
    );
  }

  return (
    <div>
      <p className="border-b border-sage-100 px-4 py-3 text-sm text-sage-600 sm:px-5">
        {uninvoiced.total.toLocaleString()} past {uninvoiced.total === 1 ? 'session' : 'sessions'}{' '}
        {scope === 'own' ? 'with your clients ' : ''}
        {uninvoiced.total === 1 ? "that isn't" : "that aren't"} on an invoice yet. Each is billed what the client owes: the
        copay for an insurance client's attended session, otherwise the fee (missed sessions bill the fee). New ones are
        invoiced automatically the day after they happen; sessions from voided invoices stay here until you invoice them
        again.
      </p>
      <ul className="divide-y divide-sage-100">
        {groups.map((group) => (
          <li key={group.client.id} className="px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium text-sage-900">{fullName(group.client)}</p>
                <p className="text-sm text-sage-600">
                  {group.sessions.length} {group.sessions.length === 1 ? 'session' : 'sessions'} ·{' '}
                  <span className="tabular-nums">{formatMoney(group.totalCents)}</span>
                </p>
              </div>
              <Button
                size="sm"
                icon={<FilePlus2 className="h-4 w-4" />}
                aria-label={`Create invoice for ${fullName(group.client)}`}
                onClick={() =>
                  openDialog({
                    kind: 'newInvoice',
                    client: group.client,
                    participantIds: group.sessions.map((session) => session.participant_id),
                  })
                }
              >
                Create invoice
              </Button>
            </div>
            <ClientSessions group={group} timeZone={timeZone} />
          </li>
        ))}
      </ul>
      <LoadMore noun="sessions" {...uninvoiced.loadMore} />
    </div>
  );
}
