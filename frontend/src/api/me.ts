import type { Session, StaffMember } from './auth';
import { api } from './client';

export type NoteFormatId = 'SOAP' | 'DAP' | 'BIRP' | 'GIRP' | 'PIRP' | 'SIRP' | 'FREEFORM';

/** Your own professional details (names, credentials, license, NPI, time zone...). */
export type ProfileUpdate = Partial<
  Pick<
    StaffMember,
    | 'first_name'
    | 'last_name'
    | 'credentials'
    | 'license_number'
    | 'license_state'
    | 'npi'
    | 'taxonomy_code'
    | 'phone'
    | 'time_zone'
    | 'accepting_new_clients'
  >
>;

/** Personal preferences: every staff member sets their own. */
export interface StaffPreferences {
  away_message_enabled: boolean;
  away_message: string;
  note_format_default: NoteFormatId;
  ai_style_instructions: string;
  notify_email_messages: boolean;
  notify_email_requests: boolean;
  notify_email_forms: boolean;
}

/** The signed-in staff member: session, own profile and personal preferences. */
export const meApi = {
  session: () => api<Session>('/me'),
  updateProfile: (changes: ProfileUpdate) => api<Session>('/me', { method: 'PATCH', body: changes }),
  preferences: () => api<StaffPreferences>('/me/preferences'),
  updatePreferences: (changes: Partial<StaffPreferences>) =>
    api<StaffPreferences>('/me/preferences', { method: 'PATCH', body: changes }),
};

/** Your private calendar subscription feed (ICS) for Google, Apple or Outlook calendars. */
export const calendarFeedApi = {
  status: () => api<{ enabled: boolean }>('/me/calendar-feed'),
  /** A new feed URL, shown once; any previous URL stops working. */
  create: () => api<{ url: string }>('/me/calendar-feed', { method: 'POST' }),
  remove: () => api<void>('/me/calendar-feed', { method: 'DELETE' }),
};

export const meKeys = {
  preferences: ['me', 'preferences'] as const,
  calendarFeed: ['me', 'calendar-feed'] as const,
};
