import type { Appointment } from '../../api/appointments';
import type { WaitingRoomEntry } from '../../api/telehealth';

/** Where a session's client is: waiting to be admitted, in the session, or not here yet. */
export type ClientPresence = 'waiting' | 'admitted' | 'absent';

/**
 * The client whose join link was used (for a waiting-room entry or a recording-consent
 * participant), by name; null when it isn't one of the clients you can see in the session.
 */
export function linkClientName(appointment: Pick<Appointment, 'participants'>, clientId: number | null): string | null {
  if (clientId === null) return null;
  return appointment.participants.find((participant) => participant.client.id === clientId)?.client.name ?? null;
}

/** Whether anyone on this client's link is in the session, else waiting, else not here yet. */
export function clientPresence(entries: WaitingRoomEntry[], clientId: number): ClientPresence {
  const own = entries.filter((entry) => entry.client_id === clientId);
  if (own.some((entry) => entry.status === 'admitted')) return 'admitted';
  if (own.some((entry) => entry.status === 'waiting')) return 'waiting';
  return 'absent';
}

export interface WaitingRoomGroups {
  /** Waiting to be admitted, longest-waiting first. */
  waiting: WaitingRoomEntry[];
  /** Admitted to the session (they may have dropped off the call since). */
  admitted: WaitingRoomEntry[];
  /** Left or declined. */
  past: WaitingRoomEntry[];
}

export function groupEntries(entries: WaitingRoomEntry[]): WaitingRoomGroups {
  const byArrival = [...entries].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  return {
    waiting: byArrival.filter((entry) => entry.status === 'waiting'),
    admitted: byArrival.filter((entry) => entry.status === 'admitted'),
    past: byArrival.filter((entry) => entry.status === 'left' || entry.status === 'declined'),
  };
}

/**
 * Who started waiting since the last look. `seen` is null before the first load, when nobody counts
 * as new (they were already waiting when the page opened).
 */
export function newArrivals(
  seen: ReadonlySet<number> | null,
  entries: WaitingRoomEntry[],
): { arrivals: WaitingRoomEntry[]; seen: Set<number> } {
  const waiting = entries.filter((entry) => entry.status === 'waiting');
  const next = new Set(seen ?? []);
  waiting.forEach((entry) => next.add(entry.id));
  if (seen === null) return { arrivals: [], seen: next };
  return { arrivals: waiting.filter((entry) => !seen.has(entry.id)), seen: next };
}

/** "Alex is waiting", "Alex and Sam are waiting", "3 people are waiting". */
export function arrivalMessage(arrivals: WaitingRoomEntry[]): string {
  if (arrivals.length === 1) return `${arrivals[0].display_name} is in the waiting room`;
  if (arrivals.length === 2) return `${arrivals[0].display_name} and ${arrivals[1].display_name} are in the waiting room`;
  return `${arrivals.length} people are in the waiting room`;
}
