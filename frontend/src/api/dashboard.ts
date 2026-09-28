import { api } from './client';
import type { Appointment } from './appointments';

/** Whose appointments today's schedule lists: mine, or everyone's (needs `schedule_all`). */
export type DashboardScope = 'mine' | 'practice';

/** A client in one of today's sessions (only clients the viewer can see are listed). */
export interface TodayParticipant {
  id: number;
  client: { id: number; name: string };
}

/** An entry on today's schedule: the API's appointment, as far as the dashboard reads it. */
export interface TodayAppointment
  extends Pick<
    Appointment,
    | 'id'
    | 'kind'
    | 'service_description'
    | 'starts_at'
    | 'ends_at'
    | 'duration_minutes'
    | 'location_type'
    | 'status'
    | 'has_video'
  > {
  /** The client's name, "A & B", the group's name or "Group (n)", an event's title, or "Busy". */
  title_label: string;
  clinician: { id: number; name: string };
  participants: TodayParticipant[];
  /** A colleague's appointment with clients the viewer can't see: just busy time. */
  restricted: boolean;
}

/** The staff home screen: today's schedule and counts of work waiting on the signed-in person. */
export interface DashboardSummary {
  scope: DashboardScope;
  today: TodayAppointment[];
  pending_requests: number;
  unread_messages: number;
  unread_notifications: number;
  draft_notes: number;
  /** Supervisees' signed notes waiting for my co-signature. */
  notes_awaiting_cosign: number;
  appointments_missing_notes: number;
  pending_forms: number;
  flagged_forms: number;
  waiting_room: number;
  /** Open invoice balances I may see (practice-wide or my clients'); null without billing access. */
  outstanding_cents: number | null;
  /** Clients I can see (not archived). */
  client_count: number;
}

export const dashboardApi = {
  get: (scope: DashboardScope) => api<DashboardSummary>('/dashboard', { query: { scope } }),
};

/** Query keys; invalidate `dashboardKeys.all` to refresh every scope. */
export const dashboardKeys = {
  all: ['dashboard'] as const,
  summary: (scope: DashboardScope) => ['dashboard', scope] as const,
};
