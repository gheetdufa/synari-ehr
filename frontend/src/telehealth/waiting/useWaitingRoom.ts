import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { telehealthApi, telehealthKeys, type WaitingRoomEntry } from '../../api/telehealth';
import { useRealtimeEvent } from '../../lib/realtime';
import { useToast } from '../../ui/Toast';
import { groupEntries, newArrivals, type WaitingRoomGroups } from './waitingRoom';

/** A light fallback in case the realtime socket is down. */
const POLL_MS = 10_000;

export interface WaitingRoom extends WaitingRoomGroups {
  entries: WaitingRoomEntry[];
  loading: boolean;
  error: unknown;
  refetch: () => void;
  admit: (entryId: number) => void;
  decline: (entryId: number) => void;
  /** Take an admitted participant out of the call. */
  remove: (entryId: number) => void;
  admitAll: () => void;
  /** Entry ids with an admit/decline in flight. */
  busyIds: ReadonlySet<number>;
  admittingAll: boolean;
}

/**
 * The waiting room for one appointment, kept live with realtime `waiting_room.updated` events plus a
 * 10-second poll. `onArrival` fires when someone new starts waiting.
 */
export function useWaitingRoom(appointmentId: number, onArrival?: (arrivals: WaitingRoomEntry[]) => void): WaitingRoom {
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = telehealthKeys.waitingRoom(appointmentId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => telehealthApi.waitingRoom(appointmentId),
    enabled: Number.isInteger(appointmentId) && appointmentId > 0,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: telehealthKeys.waitingRoom(appointmentId) });
    void queryClient.invalidateQueries({ queryKey: telehealthKeys.consent(appointmentId) });
  };

  useRealtimeEvent('waiting_room.updated', (event) => {
    if (event.data.appointment_id === appointmentId) refresh();
  });

  const seen = useRef<Set<number> | null>(null);
  const onArrivalRef = useRef(onArrival);
  onArrivalRef.current = onArrival;
  useEffect(() => {
    if (!query.data) return;
    const result = newArrivals(seen.current, query.data);
    seen.current = result.seen;
    if (result.arrivals.length > 0) onArrivalRef.current?.(result.arrivals);
  }, [query.data]);

  const onError = (error: unknown) => {
    toast.error(error);
    refresh();
  };
  const admitMutation = useMutation({ mutationFn: telehealthApi.admit, onSuccess: refresh, onError });
  const declineMutation = useMutation({ mutationFn: telehealthApi.decline, onSuccess: refresh, onError });
  const removeMutation = useMutation({ mutationFn: telehealthApi.remove, onSuccess: refresh, onError });
  const admitAllMutation = useMutation({
    mutationFn: () => telehealthApi.admitAll(appointmentId),
    onSuccess: refresh,
    onError,
  });

  const busyIds = new Set<number>();
  if (admitMutation.isPending && admitMutation.variables !== undefined) busyIds.add(admitMutation.variables);
  if (declineMutation.isPending && declineMutation.variables !== undefined) busyIds.add(declineMutation.variables);
  if (removeMutation.isPending && removeMutation.variables !== undefined) busyIds.add(removeMutation.variables);

  const entries = query.data ?? [];
  return {
    entries,
    ...groupEntries(entries),
    loading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
    admit: (entryId) => admitMutation.mutate(entryId),
    decline: (entryId) => declineMutation.mutate(entryId),
    remove: (entryId) => removeMutation.mutate(entryId),
    admitAll: () => admitAllMutation.mutate(),
    busyIds,
    admittingAll: admitAllMutation.isPending,
  };
}
