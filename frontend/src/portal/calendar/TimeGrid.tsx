import { useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react';
import type { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { Phone, Repeat, Users, Video } from 'lucide-react';
import type { Appointment } from '../../api/appointments';
import type { BusyBlock } from '../../api/calendarSync';
import { SESSION_TYPE_LABELS, blockClasses, entryTitle, isInactive, sessionType, statusLabel } from './appointmentStyles';
import { ClinicianDot } from './ClinicianFilter';
import {
  MINUTES_PER_DAY,
  busySegmentsForDay,
  compactTime,
  dayKey,
  formatTimeRange,
  hourBounds,
  hourLabel,
  layoutSegments,
  segmentsForDay,
  wallMinutes,
  zoneAbbreviation,
  zonedDateTimeToIso,
  type BusySegment,
  type PositionedSegment,
} from './calendarMath';
import type { ClinicianColors } from './clinicians';

const HOUR_HEIGHT = 56;
const PX_PER_MINUTE = HOUR_HEIGHT / 60;
/** Blocks are never drawn shorter than this, so short appointments stay clickable. */
const MIN_BLOCK_MINUTES = 20;
/** Clicking an empty slot starts a new appointment on this grid. */
const SNAP_MINUTES = 15;
/** Diagonal stripes marking busy time from a connected personal calendar. */
const HATCH = 'repeating-linear-gradient(135deg, rgb(199 210 199 / 0.55) 0 5px, rgb(246 247 246 / 0.55) 5px 10px)';

function toTimeValue(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Week and day views: a scrollable time grid with side-by-side overlapping appointments. */
export function TimeGrid({
  days,
  appointments,
  busyBlocks = [],
  timeZone,
  now,
  clinicianColors,
  onCreate,
  onOpen,
  onOpenDay,
}: {
  days: TZDate[];
  appointments: Appointment[];
  /** Busy times from connected personal calendars, drawn as hatched background. */
  busyBlocks?: BusyBlock[];
  timeZone: string;
  now: Date;
  /** Colors to tell clinicians apart when several calendars are shown. */
  clinicianColors: ClinicianColors | null;
  /** Called for a click on empty time; omitted when you can't add to the calendar. */
  onCreate?: (startsAt: string) => void;
  onOpen: (appointment: Appointment) => void;
  onOpenDay: (day: string) => void;
}) {
  const columns = useMemo(
    () =>
      days.map((day) => ({
        day,
        key: format(day, 'yyyy-MM-dd'),
        segments: layoutSegments(segmentsForDay(appointments, day, timeZone), MIN_BLOCK_MINUTES),
        busy: busySegmentsForDay(busyBlocks, day, timeZone),
      })),
    [days, appointments, busyBlocks, timeZone],
  );
  const { startHour, endHour } = useMemo(() => hourBounds(columns.flatMap((column) => column.segments)), [columns]);
  const hours = Array.from({ length: endHour - startHour }, (_, index) => startHour + index);
  const gridStart = startHour * 60;
  const todayKey = dayKey(now, timeZone);
  const nowMinute = wallMinutes(now, timeZone);
  const showsToday = columns.some((column) => column.key === todayKey);
  const template = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };

  // Scroll to an hour before now when today is shown, else to the first appointment (or 8 AM).
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTarget = useRef(0);
  const earliest = Math.min(...columns.flatMap((column) => column.segments.map((segment) => segment.startMinute)), 8 * 60 + 30);
  scrollTarget.current = Math.max(0, ((showsToday ? nowMinute - 60 : earliest - 30) - gridStart) * PX_PER_MINUTE);
  const rangeKey = `${columns[0]?.key}-${days.length}`;
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scrollTarget.current;
  }, [rangeKey]);

  const createAt = (event: MouseEvent<HTMLDivElement>, key: string) => {
    if (!onCreate || event.target !== event.currentTarget) return;
    const offset = event.clientY - event.currentTarget.getBoundingClientRect().top;
    const minute = gridStart + Math.floor(offset / PX_PER_MINUTE / SNAP_MINUTES) * SNAP_MINUTES;
    onCreate(zonedDateTimeToIso(key, toTimeValue(Math.min(Math.max(minute, 0), MINUTES_PER_DAY - SNAP_MINUTES)), timeZone));
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex overflow-hidden border-b border-sage-100 [scrollbar-gutter:stable]">
        <div className="flex w-14 shrink-0 items-end justify-end pb-1.5 pr-2 text-[10px] font-medium uppercase text-sage-400">
          {zoneAbbreviation(timeZone, days[0] ?? now)}
        </div>
        <div className="grid flex-1" style={template}>
          {columns.map(({ day, key }) => {
            const isToday = key === todayKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onOpenDay(key)}
                aria-label={`${format(day, 'EEEE, MMMM d')}${isToday ? ' (today)' : ''}: show day`}
                className="flex flex-col items-center gap-0.5 border-l border-sage-100 py-2 hover:bg-sage-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400"
              >
                <span className={`text-[11px] font-semibold uppercase tracking-wide ${isToday ? 'text-primary-700' : 'text-sage-500'}`}>
                  {format(day, 'EEE')}
                </span>
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-base font-semibold ${
                    isToday ? 'bg-primary-600 text-white' : 'text-sage-900'
                  }`}
                >
                  {format(day, 'd')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={scroller} className="max-h-[calc(100vh-22rem)] min-h-[26rem] overflow-y-auto [scrollbar-gutter:stable]">
        <div className="relative flex" style={{ height: hours.length * HOUR_HEIGHT }}>
          <div className="relative w-14 shrink-0" aria-hidden="true">
            {hours.map((hour, index) =>
              index === 0 ? null : (
                <span
                  key={hour}
                  className="absolute right-2 -translate-y-1/2 whitespace-nowrap text-[11px] text-sage-400"
                  style={{ top: index * HOUR_HEIGHT }}
                >
                  {hourLabel(hour)}
                </span>
              ),
            )}
          </div>
          <div className="relative grid flex-1" style={template}>
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              {hours.map((hour, index) => (
                <div key={hour}>
                  <div className="absolute inset-x-0 border-t border-sage-100" style={{ top: index * HOUR_HEIGHT }} />
                  <div className="absolute inset-x-0 border-t border-dashed border-sage-100/70" style={{ top: index * HOUR_HEIGHT + HOUR_HEIGHT / 2 }} />
                </div>
              ))}
            </div>
            {columns.map(({ key, segments, busy }) => {
              const isToday = key === todayKey;
              return (
                <div
                  key={key}
                  role="presentation"
                  onClick={(event) => createAt(event, key)}
                  className={`relative border-l border-sage-100 transition-colors ${onCreate ? 'cursor-pointer hover:bg-primary-50/40' : ''} ${isToday ? 'bg-primary-50/30' : ''}`}
                >
                  {busy.map((segment) => (
                    <BusyTime
                      key={`busy-${segment.block.id}-${key}`}
                      segment={segment}
                      gridStart={gridStart}
                      gridEnd={endHour * 60}
                      timeZone={timeZone}
                      color={clinicianColors?.get(segment.block.clinician_id)}
                    />
                  ))}
                  {segments.map((segment) => (
                    <AppointmentBlock
                      key={`${segment.appointment.id}-${key}`}
                      segment={segment}
                      gridStart={gridStart}
                      timeZone={timeZone}
                      clinicianColors={clinicianColors}
                      onOpen={onOpen}
                    />
                  ))}
                  {isToday && nowMinute >= gridStart && nowMinute <= endHour * 60 && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-red-500"
                      style={{ top: (nowMinute - gridStart) * PX_PER_MINUTE }}
                    >
                      <span className="absolute -left-1.5 -top-[7px] h-3 w-3 rounded-full bg-red-500" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Busy time from a connected personal calendar: hatched, behind appointments, not clickable. */
function BusyTime({
  segment,
  gridStart,
  gridEnd,
  timeZone,
  color,
}: {
  segment: BusySegment;
  gridStart: number;
  gridEnd: number;
  timeZone: string;
  color: string | undefined;
}) {
  const start = Math.max(segment.startMinute, gridStart);
  const end = Math.min(segment.endMinute, gridEnd);
  if (end <= start) return null;
  const height = (end - start) * PX_PER_MINUTE;
  return (
    <div
      data-testid="external-busy"
      className="pointer-events-none absolute inset-x-0 overflow-hidden border-y border-sage-200 px-1.5 py-0.5 text-[11px] leading-tight text-sage-600"
      style={{ top: (start - gridStart) * PX_PER_MINUTE, height, backgroundImage: HATCH }}
    >
      {height >= 20 && (
        <span className="flex min-w-0 items-center gap-1 font-medium" aria-hidden="true">
          {color && <ClinicianDot color={color} className="h-2 w-2" />}
          <span className="truncate">Busy (personal calendar)</span>
        </span>
      )}
      <span className="sr-only">
        Busy in a connected personal calendar, {formatTimeRange(segment.block.starts_at, segment.block.ends_at, timeZone)}
      </span>
    </div>
  );
}

function AppointmentBlock({
  segment,
  gridStart,
  timeZone,
  clinicianColors,
  onOpen,
}: {
  segment: PositionedSegment;
  gridStart: number;
  timeZone: string;
  clinicianColors: ClinicianColors | null;
  onOpen: (appointment: Appointment) => void;
}) {
  const { appointment } = segment;
  const minutes = Math.max(MIN_BLOCK_MINUTES, segment.endMinute - segment.startMinute);
  const height = minutes * PX_PER_MINUTE - 2;
  const width = 100 / segment.columns;
  const range = formatTimeRange(appointment.starts_at, appointment.ends_at, timeZone);
  const name = entryTitle(appointment);
  const isRequest = appointment.status === 'requested';
  const inactive = isInactive(appointment);
  const type = sessionType(appointment);
  const detail = isRequest ? 'Pending request' : appointment.kind === 'event' ? 'Event' : appointment.service_code;
  const LocationGlyph = appointment.location_type === 'video' ? Video : appointment.location_type === 'phone' ? Phone : null;
  const color = clinicianColors?.get(appointment.clinician.id);
  const className = `absolute z-10 flex flex-col overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-tight shadow-sm ${blockClasses(appointment)} ${
    segment.continuesBefore ? 'rounded-t-none' : ''
  } ${segment.continuesAfter ? 'rounded-b-none' : ''}`;
  const style = {
    top: (segment.startMinute - gridStart) * PX_PER_MINUTE + 1,
    height,
    left: `calc(${segment.column * width}% + 2px)`,
    width: `calc(${width}% - 4px)`,
  };
  const heading = (
    <span className="flex min-w-0 items-center gap-1">
      {color && <ClinicianDot color={color} className="h-2 w-2" />}
      <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
      {type !== 'individual' && <Users className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />}
      {appointment.series_id !== null && !inactive && <Repeat className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />}
      {LocationGlyph && <LocationGlyph className="h-3 w-3 shrink-0 opacity-80" aria-hidden="true" />}
    </span>
  );

  if (appointment.restricted) {
    // A colleague's appointment with clients you can't see: busy time, nothing to open.
    return (
      <div className={className} style={style} title={`Busy · ${appointment.clinician.name}`}>
        {heading}
        <span className="sr-only">{appointment.clinician.name}</span>
        {height >= 30 && <span className="truncate opacity-90">{range}</span>}
      </div>
    );
  }

  const label = [name, range, appointment.kind === 'event' ? 'event' : statusLabel(appointment.status)];
  if (type !== 'individual') label.push(`${SESSION_TYPE_LABELS[type].toLowerCase()} session`);
  if (color) label.push(appointment.clinician.name);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(appointment);
      }}
      aria-label={label.join(', ')}
      className={`${className} transition-shadow hover:z-30 hover:shadow-md focus:outline-none focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-primary-500`}
      style={style}
    >
      {height < 30 ? (
        <span className="flex min-w-0 items-center gap-1 truncate">
          {color && <ClinicianDot color={color} className="h-2 w-2" />}
          <span className="truncate">
            <span className="font-semibold">{name}</span> {compactTime(appointment.starts_at, timeZone)}
          </span>
        </span>
      ) : (
        <>
          {heading}
          <span className="truncate opacity-90">{range}</span>
          {height >= 52 && detail && <span className={`truncate ${isRequest ? 'font-semibold' : 'opacity-80'}`}>{detail}</span>}
        </>
      )}
    </button>
  );
}
