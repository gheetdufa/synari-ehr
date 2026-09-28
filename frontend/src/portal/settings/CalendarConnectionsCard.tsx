import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { CalendarCheck2, Plus, RefreshCw } from 'lucide-react';
import {
  PRIMARY_CALENDAR,
  calendarSyncApi,
  calendarSyncKeys,
  type CalendarConnection,
  type CalendarConnectionStatus,
  type CalendarProvider,
  type CalendarProviderInfo,
} from '../../api/calendarSync';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatDateTime } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, Badge, ErrorState } from '../../ui/Display';
import { Checkbox, Field, Input, Switch } from '../../ui/Form';
import { ConfirmDialog } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';

/** Leaving the app for the provider's consent page (a seam for tests). */
export const browserNavigation = {
  leave: (url: string) => window.location.assign(url),
};

const STATUS: Record<CalendarConnectionStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  active: { label: 'Connected', tone: 'success' },
  needs_reauth: { label: 'Needs reconnecting', tone: 'warning' },
  error: { label: 'Problem', tone: 'danger' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
};

const PROVIDER_NAMES: Record<CalendarProvider, string> = { google: 'Google Calendar', microsoft: 'Outlook' };

/** Why connecting failed, from the `reason` the server's redirect carries. */
export function connectErrorMessage(reason: string | null, provider: string): string {
  const name = PROVIDER_NAMES[provider as CalendarProvider] ?? 'the calendar';
  switch (reason) {
    case 'denied':
      return `Access to ${name} wasn't allowed, so nothing was connected.`;
    case 'expired':
      return 'That connection attempt expired. Please try again.';
    case 'scopes':
      return `Synari needs permission to manage its own calendar and to see when you're busy. Connect ${name} again and allow both.`;
    case 'offline':
      return `${name} didn't grant ongoing access. Please try again.`;
    case 'unavailable':
      return `${name} isn't set up on this server.`;
    default:
      return `${name} had a problem connecting. Please try again in a few minutes.`;
  }
}

/** "Primary calendar" for the main one, else the calendar's name or id. */
function calendarLabel(id: string, names: Map<string, string>): string {
  if (id === PRIMARY_CALENDAR) return names.get(id) ? `${names.get(id)} (main)` : 'Primary calendar';
  return names.get(id) ?? id;
}

/** "your main calendar", "your main calendar and 2 other calendars", "1 calendar". */
export function busyCalendarsSummary(ids: string[]): string {
  const others = ids.filter((id) => id !== PRIMARY_CALENDAR).length;
  const otherLabel = `${others} ${others === 1 ? 'calendar' : 'calendars'}`;
  if (!ids.includes(PRIMARY_CALENDAR)) return otherLabel;
  return others === 0 ? 'your main calendar' : `your main calendar and ${others} other ${others === 1 ? 'calendar' : 'calendars'}`;
}

function BusyCalendarsEditor({ connection, onDone }: { connection: CalendarConnection; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const calendars = useQuery({
    queryKey: calendarSyncKeys.calendars(connection.id),
    queryFn: () => calendarSyncApi.calendars(connection.id),
  });
  const [selected, setSelected] = useState<string[]>(connection.busy_calendar_ids);
  const [extra, setExtra] = useState('');
  const save = useMutation({
    mutationFn: (ids: string[]) => calendarSyncApi.setBusyCalendars(connection.id, ids),
    onSuccess: async () => {
      toast.success('Busy calendars saved. Busy times refresh in a few minutes.');
      await queryClient.invalidateQueries({ queryKey: calendarSyncKeys.connections });
      onDone();
    },
    onError: (error) => toast.error(error),
  });

  if (calendars.isPending) return <SectionSpinner />;
  if (calendars.isError) return <ErrorState error={calendars.error} onRetry={() => void calendars.refetch()} />;

  const names = new Map(calendars.data.map((calendar) => [calendar.id, calendar.name]));
  const options = [...new Set([...calendars.data.map((calendar) => calendar.id), ...selected])];
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => (on ? [...current, id] : current.filter((item) => item !== id)));
  const addExtra = (event: FormEvent) => {
    event.preventDefault();
    const id = extra.trim();
    if (id && !selected.includes(id)) setSelected((current) => [...current, id]);
    setExtra('');
  };

  return (
    <div className="space-y-3 rounded-lg border border-sage-100 bg-sage-50/60 p-3">
      <p className="text-sm font-medium text-sage-800">Calendars that block your availability</p>
      <div className="space-y-2">
        {options.map((id) => (
          <Checkbox
            key={id}
            label={calendarLabel(id, names)}
            checked={selected.includes(id)}
            onChange={(event) => toggle(id, event.target.checked)}
          />
        ))}
      </div>
      {connection.provider === 'google' && (
        <form onSubmit={addExtra} className="flex flex-wrap items-end gap-2">
          <Field label="Another Google calendar" hint="Its Calendar ID, from the calendar's settings in Google Calendar." className="min-w-0 flex-1">
            {(props) => (
              <Input {...props} value={extra} onChange={(event) => setExtra(event.target.value)} placeholder="name@group.calendar.google.com" />
            )}
          </Field>
          <Button type="submit" variant="secondary" icon={<Plus className="h-4 w-4" />} disabled={!extra.trim()}>
            Add
          </Button>
        </form>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={save.isPending} disabled={selected.length === 0} onClick={() => save.mutate(selected)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ConnectionRow({
  connection,
  timeZone,
  onReconnect,
  reconnecting,
}: {
  connection: CalendarConnection;
  timeZone: string;
  onReconnect: (provider: CalendarProvider) => void;
  reconnecting: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [deleteCalendar, setDeleteCalendar] = useState(true);
  const refresh = () => queryClient.invalidateQueries({ queryKey: calendarSyncKeys.all });
  const name = PROVIDER_NAMES[connection.provider];
  const status = STATUS[connection.status];

  const syncNow = useMutation({
    mutationFn: () => calendarSyncApi.syncNow(connection.id),
    onSuccess: () => {
      toast.success('Syncing. Changes appear within a few minutes.');
      void refresh();
    },
    onError: (error) => toast.error(error),
  });
  const disconnect = useMutation({
    mutationFn: () => calendarSyncApi.disconnect(connection.id, deleteCalendar),
    onSuccess: () => {
      setConfirmOff(false);
      toast.success(`${name} disconnected.`);
      void refresh();
    },
    onError: (error) => toast.error(error),
  });

  const needsAttention = connection.status === 'needs_reauth' || connection.status === 'error';
  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-sage-900">
            {name} <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="truncate text-sm text-sage-600">{connection.account_email}</p>
          <p className="mt-1 text-xs text-sage-500">
            {connection.last_busy_sync_at
              ? `Last synced ${formatDateTime(connection.last_busy_sync_at, timeZone)}`
              : 'Waiting for the first sync'}
            {connection.pending_events > 0 && ` · ${connection.pending_events} waiting to sync`}
            {connection.failed_events > 0 && ` · ${connection.failed_events} couldn't be synced`}
          </p>
          <p className="mt-1 text-xs text-sage-500">Busy times from {busyCalendarsSummary(connection.busy_calendar_ids)} block your availability.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {needsAttention && (
            <Button size="sm" loading={reconnecting} onClick={() => onReconnect(connection.provider)}>
              Reconnect
            </Button>
          )}
          <Button size="sm" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={syncNow.isPending} onClick={() => syncNow.mutate()}>
            Sync now
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing((open) => !open)} aria-expanded={editing}>
            Busy calendars
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmOff(true)}>
            Disconnect
          </Button>
        </div>
      </div>
      {connection.status === 'needs_reauth' && (
        <Alert tone="warning">Synari can no longer reach this calendar. Reconnect it to keep appointments and busy times in sync.</Alert>
      )}
      {connection.status === 'error' && connection.last_error && (
        <Alert tone="danger" title="Calendar sync is having trouble">
          {connection.last_error}
        </Alert>
      )}
      {editing && <BusyCalendarsEditor connection={connection} onDone={() => setEditing(false)} />}
      <ConfirmDialog
        open={confirmOff}
        title={`Disconnect ${name}?`}
        message={
          <div className="space-y-3">
            <p>Synari stops adding appointments to {connection.account_email} and stops reading its busy times.</p>
            <Checkbox
              label="Also delete the Synari calendar"
              description="Removes the appointments Synari added. Otherwise they stay in your account."
              checked={deleteCalendar}
              onChange={(event) => setDeleteCalendar(event.target.checked)}
            />
          </div>
        }
        confirmLabel="Disconnect"
        danger
        loading={disconnect.isPending}
        onCancel={() => setConfirmOff(false)}
        onConfirm={() => disconnect.mutate()}
      />
    </li>
  );
}

function InitialsSetting({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const canManage = useCan('manage_practice');
  const [confirmOn, setConfirmOn] = useState(false);
  const update = useMutation({
    mutationFn: (include: boolean) => calendarSyncApi.updateSettings({ include_initials: include }),
    onSuccess: (data) => {
      queryClient.setQueryData(calendarSyncKeys.settings, data);
      setConfirmOn(false);
      toast.success(data.include_initials ? 'Synced events now show client initials.' : 'Synced events no longer show client initials.');
    },
    onError: (error) => toast.error(error),
  });

  if (!canManage) {
    return (
      <p className="text-xs text-sage-500">
        {enabled ? 'Synced appointments show client initials.' : 'Synced appointments say only “Appointment”, with no client details.'}
      </p>
    );
  }
  return (
    <div className="border-t border-sage-100 pt-4">
      <Switch
        label="Show client initials on synced appointments (practice-wide)"
        description="Otherwise they say only “Appointment”. Nothing else about clients is ever sent."
        checked={enabled}
        disabled={update.isPending}
        onChange={(next) => (next ? setConfirmOn(true) : update.mutate(false))}
      />
      <ConfirmDialog
        open={confirmOn}
        title="Show client initials in connected calendars?"
        message={
          <Alert tone="warning">
            Initials are health information once they sit next to an appointment. Only turn this on if every connected account is
            covered by a Business Associate Agreement, such as Google Workspace or Microsoft 365 with a signed BAA. Personal Gmail
            and Outlook.com accounts aren't covered.
          </Alert>
        }
        confirmLabel="Show initials"
        loading={update.isPending}
        onCancel={() => setConfirmOn(false)}
        onConfirm={() => update.mutate(true)}
      />
    </div>
  );
}

/**
 * Two-way sync with Google Calendar and Outlook: each clinician connects their own accounts,
 * Synari adds appointments to a "Synari" calendar there, and busy times block online booking.
 * Hidden when the server has neither provider set up.
 */
export function CalendarConnectionsCard() {
  const { staff } = useSession();
  const canManage = useCan('manage_practice');
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [connectError, setConnectError] = useState<string | null>(null);
  const settings = useQuery({ queryKey: calendarSyncKeys.settings, queryFn: calendarSyncApi.settings });
  const connections = useQuery({
    queryKey: calendarSyncKeys.connections,
    queryFn: calendarSyncApi.connections,
    enabled: staff.is_clinician,
  });
  const connect = useMutation({
    mutationFn: calendarSyncApi.connectUrl,
    onSuccess: ({ url }) => browserNavigation.leave(url),
    onError: (error) => toast.error(error),
  });

  // Back from the provider: ?calendar_sync=connected|error&provider=...&reason=...
  const outcome = params.get('calendar_sync');
  useEffect(() => {
    if (!outcome) return;
    const provider = params.get('provider') ?? '';
    if (outcome === 'connected') {
      toast.success(`${PROVIDER_NAMES[provider as CalendarProvider] ?? 'Calendar'} connected. Your appointments sync within a few minutes.`);
    } else {
      setConnectError(connectErrorMessage(params.get('reason'), provider));
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        ['calendar_sync', 'provider', 'reason'].forEach((key) => next.delete(key));
        return next;
      },
      { replace: true },
    );
  }, [outcome, params, setParams, toast]);

  if (settings.isPending || (staff.is_clinician && connections.isPending)) return <SectionSpinner />;
  if (settings.isError) return null;
  const connected = connections.data ?? [];
  const available = settings.data.providers.filter((provider) => provider.enabled);
  if (available.length === 0 && connected.length === 0) return null;
  if (!staff.is_clinician && !canManage) return null;
  const unconnected: CalendarProviderInfo[] = available.filter(
    (provider) => !connected.some((connection) => connection.provider === provider.provider),
  );

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <CalendarCheck2 className="h-5 w-5 text-primary-600" aria-hidden="true" /> Google Calendar and Outlook
          </span>
        }
        description="Your appointments appear in a “Synari” calendar in your account, and busy times from your own calendar keep online booking from offering those times."
      />
      <CardBody className="space-y-4">
        {connectError && (
          <Alert tone="danger" title="Couldn't connect your calendar">
            {connectError}
          </Alert>
        )}
        {staff.is_clinician && (
          <>
            {connections.isError && <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />}
            {connected.length > 0 && (
              <ul className="divide-y divide-sage-100">
                {connected.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    timeZone={staff.time_zone}
                    reconnecting={connect.isPending && connect.variables === connection.provider}
                    onReconnect={(provider) => connect.mutate(provider)}
                  />
                ))}
              </ul>
            )}
            {unconnected.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {unconnected.map((provider) => (
                  <Button
                    key={provider.provider}
                    variant={connected.length > 0 ? 'secondary' : 'primary'}
                    loading={connect.isPending && connect.variables === provider.provider}
                    onClick={() => connect.mutate(provider.provider)}
                  >
                    Connect {PROVIDER_NAMES[provider.provider]}
                  </Button>
                ))}
              </div>
            )}
            <p className="text-xs text-sage-500">
              Synced appointments are private and say only when you're busy. Clients are never invited and no video links or
              notes are sent.
            </p>
          </>
        )}
        <InitialsSetting enabled={settings.data.include_initials} />
      </CardBody>
    </Card>
  );
}
