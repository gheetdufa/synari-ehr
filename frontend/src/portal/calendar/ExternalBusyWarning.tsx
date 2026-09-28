import { useQuery } from '@tanstack/react-query';
import { calendarSyncApi, calendarSyncKeys } from '../../api/calendarSync';
import { Alert } from '../../ui/Display';
import { formatTimeRange } from './calendarMath';

/**
 * A non-blocking heads-up when the chosen time overlaps busy time in the clinician's connected
 * Google or Outlook calendar. Staff can still save; only online booking avoids those times.
 */
export function ExternalBusyWarning({
  clinicianId,
  startsAt,
  endsAt,
  whose,
  timeZone,
}: {
  clinicianId: number | null;
  /** The chosen start and end (UTC ISO), or null while the time is incomplete. */
  startsAt: string | null;
  endsAt: string | null;
  /** "your" or "Jordan Lee's". */
  whose: string;
  timeZone: string;
}) {
  const ready = clinicianId !== null && startsAt !== null && endsAt !== null;
  const busy = useQuery({
    queryKey: calendarSyncKeys.busy(startsAt ?? '', endsAt ?? '', clinicianId === null ? [] : [clinicianId]),
    queryFn: () => calendarSyncApi.busy({ start: startsAt ?? '', end: endsAt ?? '', clinician_ids: clinicianId === null ? [] : [clinicianId] }),
    enabled: ready,
    retry: false,
    staleTime: 60_000,
  });
  const overlaps = ready ? (busy.data ?? []) : [];
  if (overlaps.length === 0) return null;
  const times = overlaps.map((block) => formatTimeRange(block.starts_at, block.ends_at, timeZone)).join(', ');
  return (
    <Alert tone="warning" title="Busy in a connected calendar">
      This time overlaps busy time in {whose} connected calendar ({times}). You can still save it.
    </Alert>
  );
}
