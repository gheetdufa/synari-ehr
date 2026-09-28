import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appointmentKeys } from '../../api/appointments';
import { appointmentRequestsApi, bookingKeys } from '../../api/booking';
import { practiceApi, practiceKeys } from '../../api/practice';
import { useRealtimeEvent } from '../../lib/realtime';
import { useToast } from '../../ui/Toast';

/** Refetch everything calendar-related (appointments in any range, details, requests). */
export function useInvalidateCalendar(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: appointmentKeys.all }),
      queryClient.invalidateQueries({ queryKey: bookingKeys.requests }),
    ]);
  }, [queryClient]);
}

/** Keep calendar data fresh when requests arrive or appointments change elsewhere. */
export function useCalendarRealtime(): void {
  const invalidate = useInvalidateCalendar();
  useRealtimeEvent(['appointment_request.created', 'appointment.*'], () => void invalidate());
}

export function useServices() {
  return useQuery({ queryKey: practiceKeys.services, queryFn: practiceApi.services, staleTime: 5 * 60_000 });
}

/** Pending requests on the calendars you handle (yours, or everyone's with schedule-all). */
export function usePendingRequests(enabled = true) {
  return useQuery({ queryKey: bookingKeys.requests, queryFn: () => appointmentRequestsApi.list(), enabled });
}

/** Accept and decline mutations for requests, with toasts and cache refreshes. */
export function useRequestActions() {
  const invalidate = useInvalidateCalendar();
  const toast = useToast();
  const accept = useMutation({
    mutationFn: ({ id, allowConflicts = false }: { id: number; allowConflicts?: boolean }) =>
      appointmentRequestsApi.accept(id, allowConflicts),
    onSuccess: async () => {
      toast.success('Request accepted. The client has been emailed a confirmation.');
      await invalidate();
    },
  });
  const decline = useMutation({
    mutationFn: ({ id, reason, includeReason }: { id: number; reason: string; includeReason: boolean }) =>
      appointmentRequestsApi.decline(id, { reason, include_reason: includeReason }),
    onSuccess: async () => {
      toast.success('Request declined. The requester has been emailed.');
      await invalidate();
    },
    onError: (error) => toast.error(error),
  });
  return { accept, decline };
}

/** The current time, refreshed on an interval (for the now-line and join windows). */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** Whether a CSS media query currently matches; updates on change. */
export function useMediaQuery(query: string): boolean {
  const [isMatch, setIsMatch] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = () => setIsMatch(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return isMatch;
}
