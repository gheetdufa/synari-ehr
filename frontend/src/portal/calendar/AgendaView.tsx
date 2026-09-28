import { useMemo } from 'react';
import type { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { Plus, Repeat, Users } from 'lucide-react';
import type { Appointment } from '../../api/appointments';
import { formatTime } from '../../lib/format';
import { Badge } from '../../ui/Display';
import {
  SESSION_TYPE_LABELS,
  entryTitle,
  isInactive,
  sessionType,
  statusLabel,
  statusTone,
  swatchClass,
} from './appointmentStyles';
import { LocationIcon } from './CalendarParts';
import { appointmentsByDay, dayKey, defaultStart } from './calendarMath';
import { ClinicianDot } from './ClinicianFilter';
import type { ClinicianColors } from './clinicians';

function agendaDetail(appointment: Appointment): string {
  if (appointment.restricted) return 'Busy';
  if (appointment.kind === 'event') return 'Event';
  return [appointment.service_code, appointment.service_description].filter(Boolean).join(' — ') || 'Appointment';
}

/** A list of the range's days and their appointments; the default view on phones. */
export function AgendaView({
  days,
  appointments,
  timeZone,
  now,
  clinicianColors,
  onCreate,
  onOpen,
}: {
  days: TZDate[];
  appointments: Appointment[];
  timeZone: string;
  now: Date;
  /** Colors to tell clinicians apart when several calendars are shown. */
  clinicianColors: ClinicianColors | null;
  /** Adds an appointment on a day; omitted when you can't add to the calendar. */
  onCreate?: (startsAt: string) => void;
  onOpen: (appointment: Appointment) => void;
}) {
  const byDay = useMemo(() => appointmentsByDay(appointments, days), [appointments, days]);
  const todayKey = dayKey(now, timeZone);

  return (
    <ol className="divide-y divide-sage-100">
      {days.map((day) => {
        const key = format(day, 'yyyy-MM-dd');
        const items = byDay.get(key) ?? [];
        const isToday = key === todayKey;
        return (
          <li key={key} aria-label={format(day, 'EEEE, MMMM d')}>
            <div className="sticky top-16 z-10 flex items-center justify-between gap-2 bg-sage-50/95 px-4 py-2 backdrop-blur">
              <h3 className={`text-sm font-semibold ${isToday ? 'text-primary-700' : 'text-sage-800'}`}>
                {isToday && 'Today · '}
                {format(day, 'EEEE, MMM d')}
              </h3>
              {onCreate && (
                <button
                  type="button"
                  onClick={() => onCreate(defaultStart(key, timeZone, now))}
                  aria-label={`New appointment on ${format(day, 'EEEE, MMMM d')}`}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-sage-500 hover:bg-sage-100 hover:text-sage-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
            </div>
            {items.length === 0 ? (
              <p className="px-4 py-3 text-sm text-sage-400">Nothing scheduled</p>
            ) : (
              <ul>
                {items.map((appointment) => {
                  const inactive = isInactive(appointment);
                  const startsToday = dayKey(appointment.starts_at, timeZone) === key;
                  const type = sessionType(appointment);
                  const color = clinicianColors?.get(appointment.clinician.id);
                  const content = (
                    <>
                      <span className="w-16 shrink-0 text-sm sm:w-20">
                        <span className={`block font-medium ${inactive ? 'text-sage-400' : 'text-sage-900'}`}>
                          {startsToday ? formatTime(appointment.starts_at, timeZone) : 'Cont.'}
                        </span>
                        <span className="block text-xs text-sage-500">{appointment.duration_minutes} min</span>
                      </span>
                      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${swatchClass(appointment)}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className={`flex items-center gap-1.5 font-medium ${inactive ? 'text-sage-400 line-through' : 'text-sage-900'}`}>
                          <span className="truncate">{entryTitle(appointment)}</span>
                          {type !== 'individual' && (
                            <Users className="h-3.5 w-3.5 shrink-0 text-sage-400" aria-label={`${SESSION_TYPE_LABELS[type]} session`} />
                          )}
                          {appointment.series_id !== null && <Repeat className="h-3.5 w-3.5 shrink-0 text-sage-400" aria-label="Recurring" />}
                        </span>
                        <span className="flex items-center gap-1.5 text-xs text-sage-600">
                          <LocationIcon type={appointment.location_type} className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{agendaDetail(appointment)}</span>
                        </span>
                        {color && (
                          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-sage-500">
                            <ClinicianDot color={color} className="h-2 w-2" />
                            <span className="truncate">{appointment.clinician.name}</span>
                          </span>
                        )}
                      </span>
                      {appointment.kind === 'appointment' && !appointment.restricted && appointment.status !== 'scheduled' && (
                        <span className="shrink-0">
                          <Badge tone={statusTone(appointment.status)}>{statusLabel(appointment.status)}</Badge>
                        </span>
                      )}
                    </>
                  );
                  return (
                    <li key={appointment.id}>
                      {appointment.restricted ? (
                        <div className="flex w-full items-start gap-3 px-4 py-3 text-left">{content}</div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onOpen(appointment)}
                          className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-sage-50 focus:outline-none focus-visible:bg-primary-50"
                        >
                          {content}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
