import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2, Inbox } from 'lucide-react';
import { claimsApi, claimsKeys, type Claim, type ClaimFilters, type UnbilledSession } from '../../../api/claims';
import { useSession } from '../../../auth/StaffAuth';
import { formatDate, formatMoney } from '../../../lib/format';
import { usePagedQuery } from '../../../lib/paging';
import { Button } from '../../../ui/Button';
import { Badge, EmptyState, ErrorState } from '../../../ui/Display';
import { LoadMore } from '../../../ui/LoadMore';
import { ConfirmDialog } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { createClaimsFor, groupByClient, selectionWarnings, sessionWarnings } from './queue';

/** Sessions loaded per page; the API sends each client's sessions together, by client name. */
const PAGE_SIZE = 100;

/** A checkbox that shows "some selected" as indeterminate. */
function SelectBox({
  checked,
  indeterminate = false,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(element) => {
        if (element) element.indeterminate = indeterminate;
      }}
      onChange={(event) => onChange(event.target.checked)}
      className="h-4 w-4 shrink-0 rounded border-sage-300 accent-primary-600"
    />
  );
}

/**
 * "Ready to file": attended sessions of insurance clients that aren't on a claim yet, with
 * what might get them denied. Select sessions and create draft claims (one client per claim).
 */
export function UnbilledQueue({ filters, onCreated }: { filters: ClaimFilters; onCreated: (claims: Claim[]) => void }) {
  const { practice } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const unbilled = usePagedQuery({
    queryKey: claimsKeys.unbilled(filters),
    fetchPage: (page) => claimsApi.unbilled({ ...filters, ...page }),
    pageSize: PAGE_SIZE,
  });
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);

  const sessions = unbilled.items;
  const chosen = sessions.filter((session) => selected.has(session.participant_id));
  const warnings = selectionWarnings(chosen);
  const total = chosen.reduce((sum, session) => sum + session.fee_cents, 0);

  const toggle = (items: UnbilledSession[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const session of items) {
        if (on) next.add(session.participant_id);
        else next.delete(session.participant_id);
      }
      return next;
    });

  const create = async () => {
    setConfirming(false);
    setCreating(true);
    try {
      const { created, failures } = await createClaimsFor(chosen, (participantIds) =>
        claimsApi.create({ participant_ids: participantIds }),
      );
      await queryClient.invalidateQueries({ queryKey: claimsKeys.all });
      failures.forEach((failure) => toast.error(`${failure.clientName}: ${failure.message}`));
      if (created.length > 0) {
        setSelected(new Set());
        toast.success(`Created ${created.length} draft ${created.length === 1 ? 'claim' : 'claims'}`);
        onCreated(created);
      }
    } finally {
      setCreating(false);
    }
  };

  if (unbilled.isPending) return <SectionSpinner />;
  if (unbilled.isError && !unbilled.data) return <ErrorState error={unbilled.error} onRetry={() => void unbilled.refetch()} />;
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="Nothing waiting to be billed"
        description="Attended sessions of clients billed to insurance show up here until they're on a claim."
      />
    );
  }

  const groups = groupByClient(sessions);
  const allSelected = chosen.length === sessions.length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-sage-100 px-4 py-3 sm:px-5">
        <SelectBox
          label="Select all sessions"
          checked={allSelected}
          indeterminate={chosen.length > 0 && !allSelected}
          onChange={(on) => toggle(sessions, on)}
        />
        <p className="text-sm text-sage-600">
          {chosen.length > 0
            ? `${chosen.length} of ${unbilled.total.toLocaleString()} sessions selected · ${formatMoney(total)}`
            : `${unbilled.total.toLocaleString()} ${unbilled.total === 1 ? 'session' : 'sessions'} ready to file`}
        </p>
        <Button
          className="ml-auto"
          icon={<FilePlus2 className="h-4 w-4" />}
          disabled={chosen.length === 0}
          loading={creating}
          onClick={() => (warnings.length > 0 ? setConfirming(true) : void create())}
        >
          Create claims
        </Button>
      </div>
      <ul className="divide-y divide-sage-100">
        {groups.map((group) => {
          const count = group.sessions.filter((session) => selected.has(session.participant_id)).length;
          return (
            <li key={group.clientId} className="px-4 py-3 sm:px-5">
              <div className="flex items-center gap-3">
                <SelectBox
                  label={`Select all sessions for ${group.clientName}`}
                  checked={count === group.sessions.length}
                  indeterminate={count > 0 && count < group.sessions.length}
                  onChange={(on) => toggle(group.sessions, on)}
                />
                <div className="min-w-0">
                  <p className="font-medium text-sage-900">{group.clientName}</p>
                  <p className="text-xs text-sage-500">{group.payerNames.join(', ')}</p>
                </div>
              </div>
              <ul className="mt-2 space-y-1.5 pl-7">
                {group.sessions.map((session) => {
                  const sessionLabel = `${formatDate(session.starts_at, practice.time_zone, { weekday: 'short' })} · ${
                    session.service_code
                  }`;
                  return (
                    <li key={session.participant_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <SelectBox
                        label={`Select ${group.clientName}, ${sessionLabel}`}
                        checked={selected.has(session.participant_id)}
                        onChange={(on) => toggle([session], on)}
                      />
                      <span className="text-sage-800">
                        {sessionLabel}
                        {session.service_description && (
                          <span className="text-sage-500"> {session.service_description}</span>
                        )}
                      </span>
                      <span className="text-xs text-sage-500">{session.clinician_name}</span>
                      <span className="flex flex-wrap gap-1">
                        {sessionWarnings(session).map((warning) => (
                          <Badge key={warning.kind} tone={warning.tone}>
                            {warning.label}
                          </Badge>
                        ))}
                      </span>
                      <span className="ml-auto tabular-nums text-sage-900">{formatMoney(session.fee_cents)}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      <LoadMore noun="sessions" {...unbilled.loadMore} />
      <ConfirmDialog
        open={confirming}
        title="Some sessions need attention"
        confirmLabel="Create claims anyway"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void create()}
        message={
          <div className="space-y-2">
            <ul className="list-disc space-y-1 pl-5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p>You can still create draft claims and fix these before submitting.</p>
          </div>
        }
      />
    </div>
  );
}
