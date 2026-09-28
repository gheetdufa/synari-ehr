import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { CalendarX2, ChevronLeft, ChevronRight, Globe } from 'lucide-react';
import type { BookingLocation, Slot, SlotRange } from '../../api/booking';
import { Button, IconButton } from '../../ui/Button';
import { ErrorState } from '../../ui/Display';
import { LocationLabel } from './BookingParts';
import {
  BOOKING_WEEKS,
  chunkIndexForDay,
  chunkRange,
  dayKeyOf,
  formatDayKey,
  formatDayRange,
  formatSlotTime,
  groupSlotsByDay,
  timeZoneLabel,
  weekChunk,
} from './slots';

/** Where a slot picker gets open times from (public page or client portal). */
export interface SlotSource {
  key: (range: SlotRange) => QueryKey;
  fetch: (range: SlotRange) => Promise<Slot[]>;
}

export interface SlotPickerProps {
  /** Must be stable (module constant or memoized); it feeds query keys and effects. */
  source: SlotSource;
  clinicianId: number;
  serviceId: number;
  /** Zone that dates and times are shown in. */
  timeZone: string;
  /** The practice's offices, to name where in-person slots are. */
  locations?: BookingLocation[];
  selected: Slot | null;
  onSelect: (slot: Slot) => void;
}

function sameSlot(a: Slot | null, b: Slot): boolean {
  return !!a && a.starts_at === b.starts_at && a.location_type === b.location_type && a.location_id === b.location_id;
}

/**
 * Step two of booking: browse four weeks of open times a week at a time, pick a day, then a
 * time. Each time shows how the visit happens (video, in person, phone).
 */
export function SlotPicker({ source, clinicianId, serviceId, timeZone, locations, selected, onSelect }: SlotPickerProps) {
  const queryClient = useQueryClient();
  const [now] = useState(() => new Date());
  const [chunkIndex, setChunkIndex] = useState(() =>
    selected ? (chunkIndexForDay(dayKeyOf(selected.starts_at, timeZone), timeZone, now) ?? 0) : 0,
  );
  const [pickedDay, setPickedDay] = useState<string | null>(() =>
    selected ? dayKeyOf(selected.starts_at, timeZone) : null,
  );

  const chunk = weekChunk(chunkIndex, timeZone, now);
  const range = chunkRange(chunk, clinicianId, serviceId);
  const slots = useQuery({ queryKey: source.key(range), queryFn: () => source.fetch(range) });

  const hasNextWeek = chunkIndex < BOOKING_WEEKS - 1;
  useEffect(() => {
    if (!hasNextWeek || !slots.isSuccess) return;
    const next = chunkRange(weekChunk(chunkIndex + 1, timeZone, now), clinicianId, serviceId);
    void queryClient.prefetchQuery({ queryKey: source.key(next), queryFn: () => source.fetch(next) });
  }, [chunkIndex, clinicianId, hasNextWeek, now, queryClient, serviceId, slots.isSuccess, source, timeZone]);

  const groups = groupSlotsByDay(slots.data ?? [], timeZone, chunk.days);
  const openDays = groups.filter((group) => group.slots.length > 0);
  const activeGroup = openDays.find((group) => group.dayKey === pickedDay) ?? openDays[0] ?? null;

  const goToWeek = (index: number) => {
    setChunkIndex(index);
    setPickedDay(null);
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <IconButton label="Previous week" disabled={chunkIndex === 0} onClick={() => goToWeek(chunkIndex - 1)}>
          <ChevronLeft className="h-5 w-5" />
        </IconButton>
        <p className="text-center" aria-live="polite">
          <span className="block text-sm font-semibold text-sage-900">{formatDayRange(chunk.days)}</span>
          <span className="block text-xs text-sage-500">
            {chunkIndex === 0 ? 'Starting today' : `Week ${chunkIndex + 1} of ${BOOKING_WEEKS}`}
          </span>
        </p>
        <IconButton label="Next week" disabled={!hasNextWeek} onClick={() => goToWeek(chunkIndex + 1)}>
          <ChevronRight className="h-5 w-5" />
        </IconButton>
      </div>

      <div className="grid grid-cols-7 gap-1 sm:gap-2" role="group" aria-label="Days">
        {groups.map((group) => {
          const count = group.slots.length;
          const active = activeGroup?.dayKey === group.dayKey;
          const [weekday, date] = [
            formatDayKey(group.dayKey, { weekday: 'short', month: undefined, day: undefined }),
            formatDayKey(group.dayKey, { weekday: undefined, month: undefined, day: 'numeric' }),
          ];
          const longLabel = formatDayKey(group.dayKey, { weekday: 'long', month: 'long' });
          return (
            <button
              key={group.dayKey}
              type="button"
              disabled={slots.isPending || count === 0}
              aria-pressed={active}
              aria-label={`${longLabel}: ${count === 0 ? 'no open times' : `${count} open ${count === 1 ? 'time' : 'times'}`}`}
              onClick={() => setPickedDay(group.dayKey)}
              className={`flex flex-col items-center rounded-xl border px-0.5 py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                active
                  ? 'border-primary-600 bg-primary-600 text-white shadow-sm'
                  : count > 0
                    ? 'border-sage-200 bg-white text-sage-900 hover:border-primary-400 hover:bg-primary-50'
                    : 'cursor-default border-transparent bg-sage-100/60 text-sage-400'
              }`}
            >
              <span className={`text-[11px] font-medium uppercase tracking-wide ${active ? 'text-primary-100' : ''}`}>{weekday}</span>
              <span className="text-lg font-semibold leading-tight">{date}</span>
              <span
                aria-hidden="true"
                className={`mt-0.5 text-[11px] ${active ? 'text-primary-100' : count > 0 ? 'text-primary-700' : 'text-sage-400'}`}
              >
                {slots.isPending ? '·' : count > 0 ? count : '–'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 min-h-[9rem]">
        {slots.isPending ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-busy="true" aria-label="Loading open times">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-[3.75rem] animate-pulse rounded-xl bg-sage-100" />
            ))}
          </div>
        ) : slots.isError ? (
          <ErrorState error={slots.error} onRetry={() => void slots.refetch()} />
        ) : activeGroup ? (
          <section aria-label={`Open times on ${formatDayKey(activeGroup.dayKey, { weekday: 'long', month: 'long' })}`}>
            <h3 className="mb-2 text-sm font-medium text-sage-700">
              {formatDayKey(activeGroup.dayKey, { weekday: 'long', month: 'long' })}
            </h3>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {activeGroup.slots.map((slot) => {
                const isSelected = sameSlot(selected, slot);
                return (
                  <li key={`${slot.starts_at}-${slot.location_type}-${slot.location_id ?? ''}`}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onSelect(slot)}
                      className={`flex w-full flex-col items-start rounded-xl border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                        isSelected
                          ? 'border-primary-600 bg-primary-600 text-white'
                          : 'border-sage-200 bg-white text-sage-900 hover:border-primary-400 hover:bg-primary-50'
                      }`}
                    >
                      <span className="text-sm font-semibold">{formatSlotTime(slot.starts_at, timeZone)}</span>
                      <LocationLabel
                        slot={slot}
                        locations={locations}
                        className={`mt-0.5 text-xs ${isSelected ? 'text-primary-50' : 'text-sage-600'}`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-sage-200 px-4 py-8 text-center">
            <CalendarX2 className="mb-2 h-8 w-8 text-sage-400" aria-hidden="true" />
            <p className="text-sm font-medium text-sage-900">No open times this week</p>
            <p className="mt-1 text-sm text-sage-600">
              {hasNextWeek ? 'Try the following week.' : 'Nothing is open in the next four weeks. Please check back later.'}
            </p>
            {hasNextWeek && (
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => goToWeek(chunkIndex + 1)}>
                Show next week
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-xs text-sage-600">
        <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Times shown in {timeZoneLabel(timeZone, now)}
      </p>
    </div>
  );
}
