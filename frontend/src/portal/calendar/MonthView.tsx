import { useMemo } from 'react';
import type { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { Appointment } from '../../api/appointments';
import { entryTitle, isInactive, statusLabel, swatchClass } from './appointmentStyles';
import { appointmentsByDay, compactTime, dayKey, weeksOf, zonedDateTimeToIso } from './calendarMath';
import { ClinicianDot } from './ClinicianFilter';
import type { ClinicianColors } from './clinicians';

const MAX_CHIPS = 3;
const MAX_DOTS = 4;

/** Month grid. On phones cells show dots and open the day; on larger screens they list appointments. */
export function MonthView({
  days,
  anchor,
  appointments,
  timeZone,
  now,
  compact,
  clinicianColors,
  onCreate,
  onOpen,
  onOpenDay,
}: {
  days: TZDate[];
  anchor: string;
  appointments: Appointment[];
  timeZone: string;
  now: Date;
  compact: boolean;
  /** Colors to tell clinicians apart when several calendars are shown. */
  clinicianColors: ClinicianColors | null;
  /** Called for a click on an empty part of a day; omitted when you can't add to the calendar. */
  onCreate?: (startsAt: string) => void;
  onOpen: (appointment: Appointment) => void;
  onOpenDay: (day: string) => void;
}) {
  const byDay = useMemo(() => appointmentsByDay(appointments, days), [appointments, days]);
  const weeks = weeksOf(days);
  const month = anchor.slice(0, 7);
  const todayKey = dayKey(now, timeZone);

  return (
    <div>
      <div className="grid grid-cols-7 border-b border-sage-100" aria-hidden="true">
        {weeks[0]?.map((day) => (
          <div key={day.getTime()} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-sage-500">
            {format(day, compact ? 'EEEEE' : 'EEE')}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = format(day, 'yyyy-MM-dd');
          const items = byDay.get(key) ?? [];
          const inMonth = key.startsWith(month);
          const isToday = key === todayKey;
          const dateBadge = (
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-sm ${
                isToday ? 'bg-primary-600 font-semibold text-white' : inMonth ? 'font-medium text-sage-900' : 'text-sage-400'
              }`}
            >
              {format(day, 'd')}
            </span>
          );
          const label = `${format(day, 'EEEE, MMMM d')}${isToday ? ' (today)' : ''}, ${items.length === 0 ? 'no appointments' : `${items.length} on the calendar`}`;

          if (compact) {
            return (
              <button
                key={key}
                type="button"
                onClick={() => onOpenDay(key)}
                aria-label={label}
                className={`flex min-h-[3.75rem] flex-col items-center gap-1 border-b border-r border-sage-100 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400 ${
                  inMonth ? 'bg-white' : 'bg-sage-50/70'
                }`}
              >
                {dateBadge}
                <span className="flex flex-wrap justify-center gap-0.5" aria-hidden="true">
                  {items.slice(0, MAX_DOTS).map((appointment) => (
                    <span key={appointment.id} className={`h-1.5 w-1.5 rounded-full ${swatchClass(appointment)}`} />
                  ))}
                </span>
              </button>
            );
          }

          const hidden = items.length - MAX_CHIPS;
          return (
            <div
              key={key}
              role="presentation"
              onClick={(event) => event.target === event.currentTarget && onCreate?.(zonedDateTimeToIso(key, '09:00', timeZone))}
              className={`flex min-h-[7.5rem] flex-col gap-0.5 border-b border-r border-sage-100 p-1 ${onCreate ? 'cursor-pointer hover:bg-primary-50/30' : ''} ${
                inMonth ? 'bg-white' : 'bg-sage-50/70'
              }`}
            >
              <button
                type="button"
                onClick={() => onOpenDay(key)}
                aria-label={`${label}: show day`}
                className="self-start rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
              >
                {dateBadge}
              </button>
              {items.slice(0, hidden > 0 ? MAX_CHIPS - 1 : MAX_CHIPS).map((appointment) => {
                const color = clinicianColors?.get(appointment.clinician.id);
                const content = (
                  <>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${swatchClass(appointment)}`} aria-hidden="true" />
                    <span className="shrink-0 text-sage-500">{compactTime(appointment.starts_at, timeZone)}</span>
                    {color && <ClinicianDot color={color} className="h-2 w-2" />}
                    <span className="truncate font-medium">{entryTitle(appointment)}</span>
                  </>
                );
                if (appointment.restricted) {
                  return (
                    <span
                      key={appointment.id}
                      title={`Busy · ${appointment.clinician.name}`}
                      className="flex w-full items-center gap-1.5 truncate px-1 py-0.5 text-xs text-sage-500"
                    >
                      {content}
                    </span>
                  );
                }
                return (
                  <button
                    key={appointment.id}
                    type="button"
                    onClick={() => onOpen(appointment)}
                    aria-label={[
                      entryTitle(appointment),
                      compactTime(appointment.starts_at, timeZone),
                      statusLabel(appointment.status),
                      ...(color ? [appointment.clinician.name] : []),
                    ].join(', ')}
                    className={`flex w-full items-center gap-1.5 truncate rounded px-1 py-0.5 text-left text-xs hover:bg-sage-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                      isInactive(appointment) ? 'text-sage-400 line-through' : 'text-sage-800'
                    }`}
                  >
                    {content}
                  </button>
                );
              })}
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenDay(key)}
                  className="self-start rounded px-1 text-xs font-medium text-primary-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                >
                  +{hidden + 1} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
