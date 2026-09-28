import { api } from './client';

export type CalendarProvider = 'google' | 'microsoft';
export type CalendarConnectionStatus = 'active' | 'needs_reauth' | 'error' | 'disconnected';

/** A calendar service and whether this server is set up to connect to it. */
export interface CalendarProviderInfo {
  provider: CalendarProvider;
  label: string;
  enabled: boolean;
}

export interface CalendarSyncSettings {
  providers: CalendarProviderInfo[];
  /** Synced events show client initials; otherwise they say only "Appointment". */
  include_initials: boolean;
}

/** One of your connected Google or Microsoft accounts. */
export interface CalendarConnection {
  id: number;
  provider: CalendarProvider;
  account_email: string;
  status: CalendarConnectionStatus;
  /** Calendars whose busy times block your availability ("primary" is the main one). */
  busy_calendar_ids: string[];
  /** When busy times were last read. */
  last_busy_sync_at: string | null;
  last_error: string;
  last_error_at: string | null;
  /** Appointment changes waiting to sync. */
  pending_events: number;
  /** Appointments that couldn't be synced. */
  failed_events: number;
  created_at: string;
}

export interface CalendarChoice {
  id: string;
  name: string;
}

/** Busy time in a clinician's own calendar: the times only. */
export interface BusyBlock {
  id: number;
  clinician_id: number;
  starts_at: string;
  ends_at: string;
}

/** Busy time in the clinician's connected calendar that a saved appointment overlaps. */
export interface ExternalBusyTime {
  starts_at: string;
  ends_at: string;
}

export const PRIMARY_CALENDAR = 'primary';

/** Two-way sync with Google Calendar and Outlook. */
export const calendarSyncApi = {
  settings: () => api<CalendarSyncSettings>('/calendar-sync/settings'),
  updateSettings: (changes: { include_initials: boolean }) =>
    api<CalendarSyncSettings>('/calendar-sync/settings', { method: 'PATCH', body: changes }),
  connections: () => api<CalendarConnection[]>('/calendar-sync/connections'),
  /** The provider's consent page to send the browser to. */
  connectUrl: (provider: CalendarProvider) => api<{ url: string }>(`/calendar-sync/${provider}/connect`),
  calendars: (id: number) => api<CalendarChoice[]>(`/calendar-sync/connections/${id}/calendars`),
  setBusyCalendars: (id: number, calendarIds: string[]) =>
    api<CalendarConnection>(`/calendar-sync/connections/${id}`, {
      method: 'PATCH',
      body: { busy_calendar_ids: calendarIds },
    }),
  syncNow: (id: number) => api<CalendarConnection>(`/calendar-sync/connections/${id}/sync`, { method: 'POST' }),
  disconnect: (id: number, deleteCalendar: boolean) =>
    api<void>(`/calendar-sync/connections/${id}`, { method: 'DELETE', query: { delete_calendar: deleteCalendar } }),
  /** Busy times from connected calendars you manage (default: yours), at most 62 days. */
  busy: (params: { start: string; end: string; clinician_ids?: number[] }) =>
    api<BusyBlock[]>('/calendar-sync/busy', { query: { ...params } }),
};

export const calendarSyncKeys = {
  all: ['calendar-sync'] as const,
  settings: ['calendar-sync', 'settings'] as const,
  connections: ['calendar-sync', 'connections'] as const,
  calendars: (id: number) => ['calendar-sync', 'calendars', id] as const,
  busy: (start: string, end: string, clinicianIds: number[]) => ['calendar-sync', 'busy', start, end, clinicianIds] as const,
};
