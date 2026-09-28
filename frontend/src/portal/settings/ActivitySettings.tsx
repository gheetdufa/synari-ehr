import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download, History, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import type { ClientRef } from '../../api/clients';
import { practiceApi, practiceKeys, type AuditExportFormat } from '../../api/practice';
import { teamApi, teamKeys } from '../../api/team';
import { useSession } from '../../auth/StaffAuth';
import { formatDateTime } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { EmptyState, ErrorState } from '../../ui/Display';
import { Field, Input, Select } from '../../ui/Form';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { ClientPicker } from '../clients/ClientSearch';
import { AuditEventList } from './AuditEventList';
import {
  ACTION_CATEGORIES,
  EMPTY_AUDIT_FILTERS,
  auditFiltersFrom,
  dateRangeProblem,
  hasFilters,
  shortHash,
  type AuditFilterForm,
} from './auditFilters';

/** Whether the practice's audit hash chain still verifies, with its size and head. */
function IntegrityPanel({ timeZone }: { timeZone: string }) {
  const integrity = useQuery({ queryKey: practiceKeys.auditIntegrity, queryFn: practiceApi.auditIntegrity });
  if (integrity.isPending) return null;
  if (integrity.isError) return <ErrorState error={integrity.error} onRetry={() => void integrity.refetch()} />;
  const status = integrity.data;
  const Icon = status.verified ? ShieldCheck : ShieldAlert;
  return (
    <div
      role={status.verified ? 'status' : 'alert'}
      className={`flex items-start gap-3 border-b px-5 py-3 text-sm ${
        status.verified ? 'border-emerald-100 bg-emerald-50/70 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800'
      }`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">
          {status.verified ? 'Tamper-evident log verified' : 'The audit log failed verification'}
        </p>
        {status.problem && <p className="mt-0.5">{status.problem}</p>}
        <p className="mt-0.5 text-xs opacity-80">
          {status.sealed_events.toLocaleString()} sealed events
          {status.unsealed_events > 0 && `, ${status.unsealed_events.toLocaleString()} waiting to be sealed`}
          {status.head_event_id !== null && (
            <>
              {' · '}chain head #{status.head_event_id}{' '}
              <code className="font-mono" title={status.head_hash ?? undefined}>
                {shortHash(status.head_hash)}
              </code>
            </>
          )}
          {status.last_checkpoint_at && ` · last checkpoint ${formatDateTime(status.last_checkpoint_at, timeZone)}`}
        </p>
      </div>
    </div>
  );
}

function Filters({
  form,
  client,
  onChange,
  onClientChange,
}: {
  form: AuditFilterForm;
  client: ClientRef | null;
  onChange: (patch: Partial<AuditFilterForm>) => void;
  onClientChange: (client: ClientRef | null) => void;
}) {
  const team = useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list });
  const members = [...(team.data ?? [])].sort((a, b) => a.display_name.localeCompare(b.display_name));
  const rangeProblem = dateRangeProblem(form);
  return (
    <div className="grid gap-3 border-b border-sage-100 px-5 py-4 sm:grid-cols-2 xl:grid-cols-5" role="group" aria-label="Filter activity">
      <Field label="Client">
        {(props) => (
          <ClientPicker
            access="profile"
            id={props.id}
            value={client}
            onChange={onClientChange}
            placeholder="Any client"
            clearLabel="Clear client filter"
          />
        )}
      </Field>
      <Field label="Team member">
        {(props) => (
          <Select
            {...props}
            value={form.actorId ?? ''}
            onChange={(event) => onChange({ actorId: event.target.value ? Number(event.target.value) : null })}
          >
            <option value="">Anyone</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.display_name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Activity">
        {(props) => (
          <Select {...props} value={form.action} onChange={(event) => onChange({ action: event.target.value })}>
            <option value="">All activity</option>
            {ACTION_CATEGORIES.map((category) => (
              <option key={category.prefix} value={category.prefix}>
                {category.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="From" error={rangeProblem}>
        {(props) => (
          <Input {...props} type="date" value={form.fromDay} onChange={(event) => onChange({ fromDay: event.target.value })} />
        )}
      </Field>
      <Field label="To">
        {(props) => (
          <Input {...props} type="date" value={form.toDay} onChange={(event) => onChange({ toDay: event.target.value })} />
        )}
      </Field>
    </div>
  );
}

/**
 * The practice's audit trail, newest first: filters (client, team member, kind of activity,
 * dates in your time zone), exports with the hash-chain head, and the chain's verification.
 * Viewing and exporting the log are themselves recorded in it.
 */
export function ActivitySettings() {
  const { staff } = useSession();
  const timeZone = staff.time_zone;
  const toast = useToast();
  const [form, setForm] = useState<AuditFilterForm>(EMPTY_AUDIT_FILTERS);
  const [client, setClient] = useState<ClientRef | null>(null);
  const [exporting, setExporting] = useState<AuditExportFormat | null>(null);
  const filters = auditFiltersFrom(form, timeZone);

  const log = useInfiniteQuery({
    queryKey: practiceKeys.auditLog(filters),
    queryFn: ({ pageParam }) => practiceApi.auditLog(filters, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
  const events = log.data?.pages.flatMap((page) => page.events) ?? [];

  const change = (patch: Partial<AuditFilterForm>) => setForm((current) => ({ ...current, ...patch }));
  const chooseClient = (next: ClientRef | null) => {
    setClient(next);
    change({ clientId: next?.id ?? null });
  };
  const clear = () => {
    setForm(EMPTY_AUDIT_FILTERS);
    setClient(null);
  };
  const exportLog = async (format: AuditExportFormat) => {
    setExporting(format);
    try {
      await practiceApi.exportAuditLog(format, filters);
    } catch (error) {
      toast.error(error);
    } finally {
      setExporting(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Activity log"
        description="Sign-ins, record access and changes by everyone in the practice, kept for compliance in a tamper-evident chain. Times are in your time zone."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="h-4 w-4" />}
              loading={exporting === 'csv'}
              disabled={exporting !== null}
              onClick={() => void exportLog('csv')}
            >
              Export CSV
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="h-4 w-4" />}
              loading={exporting === 'ndjson'}
              disabled={exporting !== null}
              onClick={() => void exportLog('ndjson')}
            >
              Export NDJSON
            </Button>
          </div>
        }
      />
      <IntegrityPanel timeZone={timeZone} />
      <Filters form={form} client={client} onChange={change} onClientChange={chooseClient} />
      {hasFilters(form) && (
        <div className="flex justify-end border-b border-sage-100 px-5 py-2">
          <Button variant="ghost" size="sm" icon={<X className="h-4 w-4" />} onClick={clear}>
            Clear filters
          </Button>
        </div>
      )}
      {log.isPending && <SectionSpinner />}
      {log.isError && <ErrorState error={log.error} onRetry={() => void log.refetch()} />}
      {log.data && events.length === 0 && (
        <EmptyState
          icon={<History />}
          title={hasFilters(form) ? 'No matching activity' : 'No activity yet'}
          description={hasFilters(form) ? 'Try a wider date range or fewer filters.' : undefined}
        />
      )}
      {events.length > 0 && (
        <>
          <AuditEventList events={events} timeZone={timeZone} currentStaffId={staff.id} label="Practice activity" />
          <div className="flex justify-center border-t border-sage-100 px-5 py-3">
            {log.hasNextPage ? (
              <Button variant="secondary" size="sm" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                Load more
              </Button>
            ) : (
              <p className="text-xs text-sage-500">That&apos;s everything.</p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
