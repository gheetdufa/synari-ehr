import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Inbox, Plus } from 'lucide-react';
import { appointmentKeys, appointmentsApi } from '../../api/appointments';
import { calendarSyncApi, calendarSyncKeys } from '../../api/calendarSync';
import { useSession } from '../../auth/StaffAuth';
import { Button, IconButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ErrorState, PageHeader } from '../../ui/Display';
import { Spinner } from '../../ui/Spinner';
import { isInactive } from './appointmentStyles';
import { AgendaView } from './AgendaView';
import { SegmentedControl } from './CalendarParts';
import { useCalendarRealtime, useMediaQuery, useNow, usePendingRequests, useServices } from './calendarHooks';
import { ClinicianDot, ClinicianFilter } from './ClinicianFilter';
import {
  canManageCalendar,
  canSchedule,
  effectiveSelection,
  readSelection,
  saveSelection,
  selectedClinicians,
  useClinicians,
  type CalendarClinician,
  type ClinicianSelection,
} from './clinicians';
import {
  CALENDAR_VIEWS,
  dayKey,
  defaultStart,
  isDayKey,
  rangeLabel,
  shiftAnchor,
  visibleRange,
  zoneName,
  type CalendarView,
} from './calendarMath';
import { MonthView } from './MonthView';
import { RequestsPanel } from './RequestsPanel';
import { TimeGrid } from './TimeGrid';
import { useAppointmentDialogs } from './useAppointmentDialogs';

const SHOW_CANCELED_KEY = 'synari.calendar.showCanceled';
const VIEW_LABELS: Record<CalendarView, string> = { day: 'Day', week: 'Week', month: 'Month', agenda: 'Agenda' };

function readShowCanceled(): boolean {
  try {
    return localStorage.getItem(SHOW_CANCELED_KEY) !== 'false';
  } catch {
    return true;
  }
}

function isView(value: string | null): value is CalendarView {
  return value !== null && (CALENDAR_VIEWS as string[]).includes(value);
}

/**
 * The practice calendar: week, day, month and agenda views of the chosen clinicians' calendars,
 * with requests and appointment dialogs.
 */
export default function CalendarPage() {
  const session = useSession();
  const { staff, practice } = session;
  const timeZone = staff.time_zone;
  const scheduler = canSchedule(session);
  const now = useNow(60_000);
  const isPhone = useMediaQuery('(max-width: 767px)');
  const [params, setParams] = useSearchParams();
  const [showCanceled, setShowCanceled] = useState(readShowCanceled);
  const [storedSelection, setStoredSelection] = useState<ClinicianSelection>(() => readSelection(session));
  const { clinicians } = useClinicians();
  const { selection, shownClinicians, clinicianColors } = useMemo(() => {
    const effective = effectiveSelection(storedSelection, clinicians, session);
    const shown = clinicians ? selectedClinicians(effective, clinicians) : [];
    return {
      selection: effective,
      shownClinicians: shown,
      clinicianColors: shown.length > 1 ? new Map(shown.map((clinician) => [clinician.id, clinician.color])) : null,
    };
  }, [storedSelection, clinicians, session]);
  const clinicianIds = selection === 'all' ? null : selection;

  const viewParam = params.get('view');
  const requestedView: CalendarView = isView(viewParam) ? viewParam : isPhone ? 'agenda' : 'week';
  // Phones have no room for seven columns; they get the single-day grid instead.
  const view: CalendarView = isPhone && requestedView === 'week' ? 'day' : requestedView;
  const dateParam = params.get('date');
  const anchor = isDayKey(dateParam) ? dateParam : dayKey(now, timeZone);
  const range = useMemo(() => visibleRange(view, anchor, timeZone), [view, anchor, timeZone]);
  const start = new Date(range.start.getTime()).toISOString();
  const end = new Date(range.end.getTime()).toISOString();

  useCalendarRealtime();
  useServices();
  const requests = usePendingRequests(scheduler);
  const pendingCount = requests.data?.length ?? 0;

  const appointments = useQuery({
    queryKey: appointmentKeys.calendar(start, end, clinicianIds),
    queryFn: () => appointmentsApi.list({ start, end, include_canceled: true, clinician_ids: clinicianIds ?? undefined }),
    placeholderData: keepPreviousData,
  });
  const visible = useMemo(
    () => (appointments.data ?? []).filter((appointment) => showCanceled || !isInactive(appointment)),
    [appointments.data, showCanceled],
  );
  const hiddenCount = (appointments.data?.length ?? 0) - visible.length;

  // Busy times from connected Google/Outlook calendars, on the calendars you manage.
  const busyClinicianIds = useMemo(
    () => shownClinicians.filter((clinician) => canManageCalendar(session, clinician.id)).map((clinician) => clinician.id),
    [shownClinicians, session],
  );
  const showsGrid = view === 'day' || view === 'week';
  const busy = useQuery({
    queryKey: calendarSyncKeys.busy(start, end, busyClinicianIds),
    queryFn: () => calendarSyncApi.busy({ start, end, clinician_ids: busyClinicianIds }),
    enabled: showsGrid && busyClinicianIds.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const busyBlocks = showsGrid ? (busy.data ?? []) : [];

  const updateParams = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const dialogs = useAppointmentDialogs({ timeZone });
  const { openCreate, openDetailsById } = dialogs;
  // New entries go on the one calendar shown, when you manage it; otherwise the form decides.
  const onlyClinician = shownClinicians.length === 1 ? shownClinicians[0].id : null;
  const newEntryClinician = onlyClinician !== null && canManageCalendar(session, onlyClinician) ? onlyClinician : null;

  // Deep links: ?new=1&client=ID opens a new appointment; ?appointment=ID opens its details.
  const handledLink = useRef(false);
  useEffect(() => {
    if (handledLink.current) return;
    handledLink.current = true;
    const clientParam = Number(params.get('client'));
    const appointmentParam = Number(params.get('appointment'));
    if (params.get('new') === '1') {
      if (scheduler) {
        openCreate({
          startsAt: defaultStart(anchor, timeZone, new Date()),
          clientId: Number.isInteger(clientParam) && clientParam > 0 ? clientParam : null,
        });
      }
      updateParams({ new: null, client: null });
    } else if (Number.isInteger(appointmentParam) && appointmentParam > 0) {
      openDetailsById(appointmentParam);
      updateParams({ appointment: null });
    }
  }, [params, anchor, timeZone, scheduler, openCreate, openDetailsById, updateParams]);

  const requestsOpen = params.get('requests') === '1';
  const setView = (next: CalendarView) => updateParams({ view: next });
  const goTo = (day: string, nextView?: CalendarView) => updateParams({ date: day, ...(nextView ? { view: nextView } : {}) });
  const toggleCanceled = (next: boolean) => {
    setShowCanceled(next);
    try {
      localStorage.setItem(SHOW_CANCELED_KEY, String(next));
    } catch {
      // The preference just won't persist (private browsing).
    }
  };

  const viewOptions = CALENDAR_VIEWS.filter((option) => !(isPhone && option === 'week')).map((option) => ({
    value: option,
    label: VIEW_LABELS[option],
  }));
  const openDay = (day: string) => goTo(day, 'day');
  const createAt = scheduler ? (startsAt: string) => openCreate({ startsAt, clinicianId: newEntryClinician }) : undefined;
  const chooseClinicians = (next: ClinicianSelection) => {
    setStoredSelection(next);
    saveSelection(staff.id, next);
  };
  const todayKey = dayKey(now, timeZone);

  return (
    <div>
      <PageHeader
        title="Calendar"
        description={`Times shown in ${zoneName(timeZone)}`}
        actions={
          scheduler && (
            <>
              <Button
                variant="secondary"
                icon={<Inbox className="h-4 w-4" />}
                onClick={() => updateParams({ requests: '1' })}
                aria-label={pendingCount > 0 ? `Requests, ${pendingCount} pending` : 'Requests'}
              >
                Requests
                {pendingCount > 0 && (
                  <span className="rounded-full bg-primary-600 px-1.5 text-xs font-semibold text-white">{pendingCount}</span>
                )}
              </Button>
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => createAt?.(defaultStart(anchor, timeZone, new Date()))}>
                New
              </Button>
            </>
          )
        }
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-sage-100 px-3 py-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-1">
            <Button variant="secondary" size="sm" onClick={() => goTo(todayKey)} disabled={anchor === todayKey && view !== 'month'}>
              Today
            </Button>
            <IconButton label={`Previous ${view === 'agenda' ? 'week' : view}`} onClick={() => goTo(shiftAnchor(view, anchor, -1, timeZone))}>
              <ChevronLeft className="h-5 w-5" />
            </IconButton>
            <IconButton label={`Next ${view === 'agenda' ? 'week' : view}`} onClick={() => goTo(shiftAnchor(view, anchor, 1, timeZone))}>
              <ChevronRight className="h-5 w-5" />
            </IconButton>
            <h2 className="ml-1 truncate text-base font-semibold text-sage-900 sm:text-lg" aria-live="polite">
              {rangeLabel(view, anchor, timeZone)}
            </h2>
            {appointments.isFetching && <Spinner className="ml-2 h-4 w-4 text-primary-600" />}
          </div>
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            {clinicians && clinicians.length > 1 && (
              <ClinicianFilter
                clinicians={clinicians}
                selection={selection}
                myId={staff.is_clinician ? staff.id : null}
                onChange={chooseClinicians}
              />
            )}
            <label className="flex items-center gap-2 text-sm text-sage-700">
              <input
                type="checkbox"
                checked={showCanceled}
                onChange={(event) => toggleCanceled(event.target.checked)}
                className="h-4 w-4 rounded border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
              />
              Show canceled
              {!showCanceled && hiddenCount > 0 && <span className="text-xs text-sage-500">({hiddenCount} hidden)</span>}
            </label>
            <SegmentedControl label="Calendar view" className="flex-1 sm:flex-none" options={viewOptions} value={view} onChange={setView} />
          </div>
        </div>

        {appointments.isError && !appointments.data ? (
          <ErrorState error={appointments.error} onRetry={() => void appointments.refetch()} />
        ) : view === 'month' ? (
          <MonthView
            days={range.days}
            anchor={anchor}
            appointments={visible}
            timeZone={timeZone}
            now={now}
            compact={isPhone}
            clinicianColors={clinicianColors}
            onCreate={createAt}
            onOpen={dialogs.openDetails}
            onOpenDay={openDay}
          />
        ) : view === 'agenda' ? (
          <AgendaView
            days={range.days}
            appointments={visible}
            timeZone={timeZone}
            now={now}
            clinicianColors={clinicianColors}
            onCreate={createAt}
            onOpen={dialogs.openDetails}
          />
        ) : (
          <TimeGrid
            days={range.days}
            appointments={visible}
            busyBlocks={busyBlocks}
            timeZone={timeZone}
            now={now}
            clinicianColors={clinicianColors}
            onCreate={createAt}
            onOpen={dialogs.openDetails}
            onOpenDay={openDay}
          />
        )}
      </Card>

      <Legend clinicians={clinicianColors ? shownClinicians : []} showBusy={busyBlocks.length > 0} />

      {scheduler && (
        <RequestsPanel
          open={requestsOpen}
          timeZone={timeZone}
          bookingSlug={practice.booking_slug}
          onClose={() => updateParams({ requests: null })}
          onShowDay={(day) => updateParams({ requests: null, date: day, view: isPhone ? 'agenda' : 'day' })}
        />
      )}
      {dialogs.element}
    </div>
  );
}

function Legend({ clinicians, showBusy }: { clinicians: CalendarClinician[]; showBusy: boolean }) {
  const items: { label: string; className: string; style?: CSSProperties }[] = [
    { label: 'Scheduled', className: 'bg-primary-600' },
    { label: 'Attended', className: 'bg-emerald-600' },
    { label: 'No show', className: 'bg-amber-500' },
    { label: 'Late canceled', className: 'bg-red-400' },
    { label: 'Pending request', className: 'bg-white ring-2 ring-inset ring-primary-500' },
    { label: 'Event', className: 'bg-violet-400' },
    { label: 'Canceled', className: 'bg-sage-300' },
    { label: 'Busy (not your clients)', className: 'bg-sage-400' },
  ];
  if (showBusy) {
    items.push({
      label: 'Busy (personal calendar)',
      className: 'ring-1 ring-inset ring-sage-300',
      style: { backgroundImage: 'repeating-linear-gradient(135deg, #c7d2c7 0 2px, #f6f7f6 2px 4px)' },
    });
  }
  return (
    <div className="mt-3 space-y-1">
      <ul className="hidden flex-wrap gap-x-4 gap-y-1 text-xs text-sage-600 md:flex" aria-label="Legend">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${item.className}`} style={item.style} aria-hidden="true" />
            {item.label}
          </li>
        ))}
      </ul>
      {clinicians.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-sage-600" aria-label="Clinician colors">
          {clinicians.map((clinician) => (
            <li key={clinician.id} className="flex items-center gap-1.5">
              <ClinicianDot color={clinician.color} className="h-2 w-2" />
              {clinician.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
