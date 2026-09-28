import type { ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CalendarDays, FileSignature, Video, Wallet } from 'lucide-react';
import { dashboardApi, dashboardKeys, type DashboardScope, type DashboardSummary } from '../../api/dashboard';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatDate, formatMoney } from '../../lib/format';
import { useRealtimeEvent } from '../../lib/realtime';
import { Card, CardHeader } from '../../ui/Card';
import { ErrorState, PageHeader } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { seesClinicalRecords } from '../navigation';
import { AttentionList } from './AttentionList';
import { attentionItems, greetingFor } from './dashboardHelpers';
import { FirstRunCard } from './FirstRunCard';
import { TodaySchedule } from './TodaySchedule';
import { useNow } from './useNow';

const REFRESH_EVENTS = [
  'appointment*',
  'message.*',
  'waiting_room.updated',
  'client_form.*',
  'notification.created',
  'billing.changed',
];

const SCOPE_LABELS: Record<DashboardScope, string> = { mine: 'Mine', practice: 'Whole practice' };

function WaitingRoomBanner({ count }: { count: number }) {
  return (
    <Link
      to="/portal/telehealth"
      className="flex items-center gap-3 rounded-xl border border-primary-200 bg-primary-600 px-4 py-3 text-white shadow-sm transition-colors hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:ring-offset-2"
    >
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
        <Video className="h-5 w-5" aria-hidden="true" />
        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-300" />
      </span>
      <span className="flex-1 text-sm font-medium">
        {count === 1 ? 'A client is' : `${count} clients are`} waiting in your telehealth waiting room.
      </span>
      <span className="hidden items-center gap-1 text-sm font-semibold sm:flex">
        Open telehealth <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </Link>
  );
}

/** A headline number that links to where it's handled. */
function LinkCard({
  to,
  icon,
  label,
  value,
  action,
  tone = 'default',
}: {
  to: string;
  icon: ReactNode;
  label: string;
  value: string;
  action: string;
  tone?: 'default' | 'attention';
}) {
  return (
    <Card className={tone === 'attention' ? 'border-amber-200 bg-amber-50/60' : undefined}>
      <Link
        to={to}
        className="flex items-center gap-4 rounded-xl px-5 py-4 transition-colors hover:bg-sage-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
      >
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg [&>svg]:h-5 [&>svg]:w-5 ${
            tone === 'attention' ? 'bg-amber-100 text-amber-800' : 'bg-warm-100 text-warm-800'
          }`}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-sage-600">{label}</span>
          <span className="block text-xl font-semibold tabular-nums text-sage-900">{value}</span>
        </span>
        <span className="flex items-center gap-1 text-sm font-medium text-primary-700">
          {action} <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </span>
      </Link>
    </Card>
  );
}

/** "Mine / Whole practice" switch for staff who manage every calendar. */
function ScopeToggle({ scope, onChange }: { scope: DashboardScope; onChange: (scope: DashboardScope) => void }) {
  return (
    <div role="group" aria-label="Whose schedule" className="inline-flex rounded-lg border border-sage-200 bg-sage-50 p-0.5">
      {(Object.keys(SCOPE_LABELS) as DashboardScope[]).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={scope === option}
          onClick={() => onChange(option)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
            scope === option ? 'bg-white text-sage-900 shadow-sm' : 'text-sage-600 hover:text-sage-900'
          }`}
        >
          {SCOPE_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

/** The dashboard for `summary` (whose `scope` says which schedule it lists). */
function DashboardContent({
  summary,
  requestedScope,
  onScopeChange,
  now,
}: {
  summary: DashboardSummary;
  requestedScope: DashboardScope;
  onScopeChange: ((scope: DashboardScope) => void) | null;
  now: Date;
}) {
  const session = useSession();
  const { staff } = session;
  const { scope } = summary;
  const canSetUpPractice = useCan('manage_practice');
  const ownBilling = !useCan('billing_all');
  const appointmentCount = summary.today.filter((item) => item.kind === 'appointment').length;
  const schedulesAll = useCan('schedule_all');
  const items = attentionItems(summary, {
    clinical: seesClinicalRecords(session),
    clinician: staff.is_clinician,
    schedules: staff.is_clinician || schedulesAll,
  });
  const cosign = summary.notes_awaiting_cosign;

  return (
    <div className="space-y-6">
      {summary.client_count === 0 && canSetUpPractice && <FirstRunCard />}
      {summary.waiting_room > 0 && <WaitingRoomBanner count={summary.waiting_room} />}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Today"
            description={
              appointmentCount === 0
                ? 'No appointments scheduled'
                : `${appointmentCount} ${appointmentCount === 1 ? 'appointment' : 'appointments'}${
                    scope === 'practice' ? ' across the practice' : ''
                  }`
            }
            actions={
              <div className="flex flex-wrap items-center gap-3">
                {onScopeChange && <ScopeToggle scope={requestedScope} onChange={onScopeChange} />}
                <Link
                  to="/portal/calendar"
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
                >
                  <CalendarDays className="h-4 w-4" aria-hidden="true" /> Calendar
                </Link>
              </div>
            }
          />
          <TodaySchedule appointments={summary.today} timeZone={staff.time_zone} now={now} staffId={staff.id} scope={scope} />
        </Card>
        <div className="space-y-6">
          {cosign > 0 && (
            <LinkCard
              to="/portal/notes?view=cosign"
              icon={<FileSignature />}
              label="Notes awaiting your co-signature"
              value={String(cosign)}
              action="Review"
              tone="attention"
            />
          )}
          {items.length > 0 && (
            <Card>
              <CardHeader title="Needs your attention" />
              <AttentionList items={items} />
            </Card>
          )}
          {summary.outstanding_cents !== null && (
            <LinkCard
              to="/portal/billing"
              icon={<Wallet />}
              label={ownBilling ? "Your clients' outstanding balance" : 'Outstanding balance'}
              value={formatMoney(summary.outstanding_cents)}
              action="Billing"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The staff home: greeting, today's schedule and everything waiting on the signed-in person. */
export default function DashboardPage() {
  const { staff } = useSession();
  const canSeePractice = useCan('schedule_all');
  const [params, setParams] = useSearchParams();
  const scope: DashboardScope = canSeePractice && params.get('scope') === 'practice' ? 'practice' : 'mine';
  const queryClient = useQueryClient();
  const now = useNow();
  const summary = useQuery({
    queryKey: dashboardKeys.summary(scope),
    queryFn: () => dashboardApi.get(scope),
    placeholderData: keepPreviousData,
  });

  useRealtimeEvent(REFRESH_EVENTS, () => queryClient.invalidateQueries({ queryKey: dashboardKeys.all }));

  const changeScope = (next: DashboardScope) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === 'practice') updated.set('scope', 'practice');
        else updated.delete('scope');
        return updated;
      },
      { replace: true },
    );

  const timeZone = staff.time_zone;
  return (
    <div>
      <PageHeader
        title={`${greetingFor(now, timeZone)}, ${staff.first_name}`}
        description={formatDate(now.toISOString(), timeZone, { weekday: 'long', month: 'long', year: undefined })}
      />
      {summary.isPending && <SectionSpinner />}
      {summary.isError && (
        <Card>
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        </Card>
      )}
      {summary.data && (
        <DashboardContent
          summary={summary.data}
          requestedScope={scope}
          onScopeChange={canSeePractice ? changeScope : null}
          now={now}
        />
      )}
    </div>
  );
}
