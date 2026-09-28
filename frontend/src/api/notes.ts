import { api, apiPage, type PageParams } from './client';
import type { ClientRef } from './clients';
import type { NoteFormatId } from './me';

export type { NoteFormatId } from './me';

/** A draft, signed by a supervisee and waiting for their supervisor, or signed (and locked). */
export type NoteStatus = 'draft' | 'pending_cosign' | 'signed';
export type NoteType = 'progress' | 'intake' | 'treatment_plan' | 'consultation' | 'psychotherapy' | 'other';
/** Whether a signed text still matches the hash taken when it was signed. */
export type Integrity = 'verified' | 'mismatch';
export type RiskLevel = 'none' | 'low' | 'moderate' | 'high';

/** One heading of a structured note format, with guidance on what belongs under it. */
export interface NoteSection {
  id: string;
  label: string;
  guidance: string;
}

/** A documentation format; FREEFORM has no sections and uses `content` instead. */
export interface NoteFormat {
  id: NoteFormatId;
  name: string;
  description: string;
  sections: NoteSection[];
}

/** A staff member behind a note, by name (with credentials). */
export interface StaffRef {
  id: number;
  name: string;
}

export interface NoteSummary {
  id: number;
  client: ClientRef;
  author: StaffRef;
  appointment_id: number | null;
  note_type: NoteType;
  format: NoteFormatId;
  title: string;
  status: NoteStatus;
  /** When the author signed; kept while the note waits for and after its co-signature. */
  signed_at: string | null;
  /** The supervisor asked to co-sign (set when a supervisee signs). */
  supervisor: StaffRef | null;
  cosigned_at: string | null;
  /** Why the supervisor sent the note back (cleared once it's co-signed). */
  supervisor_comment: string;
  was_signed: boolean;
  ai_generated: boolean;
  risk_level: RiskLevel;
  risk_flags: string[];
  appointment_starts_at: string | null;
  /** Clients in the linked session (0 without one); over 1 means each client has their own note. */
  appointment_participant_count: number;
  /** Null for drafts; "mismatch" means the signed text no longer matches its signature hash. */
  integrity: Integrity | null;
  created_at: string;
  updated_at: string;
}

export interface Note extends NoteSummary {
  sections: Record<string, string>;
  content: string;
  /** Signed versions kept so far (each signature and co-signature adds one). */
  revision_count: number;
  addendum_count: number;
  /** Why the note was unlocked (or sent back); saved with its next signature. */
  pending_revision_reason: string;
}

/** A signed version of a note. */
export interface NoteRevision {
  id: number;
  version: number;
  title: string;
  sections: Record<string, string>;
  content: string;
  content_sha256: string;
  signed_by: StaffRef;
  signed_at: string;
  cosigned_by: StaffRef | null;
  cosigned_at: string | null;
  /** Why the previous version was unlocked or sent back (empty for the first version). */
  reason: string;
  created_at: string;
  integrity: Integrity;
}

/** An addition to a signed note that leaves the signed text untouched. */
export interface NoteAddendum {
  id: number;
  note_id: number;
  author: StaffRef;
  content: string;
  content_sha256: string;
  /** Set when the addendum records an accepted amendment request from the client. */
  amendment_request_id: number | null;
  created_at: string;
  integrity: Integrity;
}

export interface NoteCreate {
  client_id: number;
  appointment_id?: number | null;
  note_type?: NoteType;
  format?: NoteFormatId;
  title?: string;
  sections?: Record<string, string>;
  content?: string;
  risk_level?: RiskLevel;
  risk_flags?: string[];
}

/** Drafts for everyone in a session, each starting from the same text. */
export interface GroupNoteCreate {
  note_type?: NoteType;
  format?: NoteFormatId;
  title?: string;
  sections?: Record<string, string>;
  content?: string;
}

/** Partial update of a draft. `sections` replaces all section text. */
export interface NoteUpdate {
  appointment_id?: number | null;
  note_type?: NoteType;
  format?: NoteFormatId;
  title?: string;
  sections?: Record<string, string>;
  content?: string;
  risk_level?: RiskLevel;
  risk_flags?: string[];
}

export interface NoteListParams extends PageParams {
  client_id?: number;
  appointment_id?: number;
  author_id?: number;
  status?: NoteStatus;
  note_type?: NoteType;
}

/** The note backlog counts from the dashboard endpoint (all about the signed-in staff member). */
export interface NoteBacklog {
  draft_notes: number;
  appointments_missing_notes: number;
  /** Supervisees' signed notes waiting for my co-signature. */
  notes_awaiting_cosign: number;
}

export const FREEFORM: NoteFormatId = 'FREEFORM';
/** Server limits on note text. */
export const MAX_SECTION_CHARS = 20_000;
export const MAX_CONTENT_CHARS = 60_000;
export const MAX_RISK_FLAGS = 20;

/** Longest comment a supervisor can send with a note they return. */
export const MAX_COMMENT_CHARS = 5_000;
/** Longest reason for unlocking a signed note. */
export const MAX_UNLOCK_REASON_CHARS = 1_000;
/** Longest addendum. */
export const MAX_ADDENDUM_CHARS = 20_000;

export const NOTE_STATUS_LABELS: Record<NoteStatus, string> = {
  draft: 'Draft',
  pending_cosign: 'Awaiting co-sign',
  signed: 'Signed',
};

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  progress: 'Progress note',
  intake: 'Intake note',
  treatment_plan: 'Treatment plan',
  consultation: 'Consultation note',
  psychotherapy: 'Psychotherapy note',
  other: 'Other',
};

/** How psychotherapy notes are handled, shown wherever one is chosen or opened. */
export const PSYCHOTHERAPY_NOTE_BADGE = 'Psychotherapy note — kept separate from the record';
export const PSYCHOTHERAPY_NOTE_HELP =
  "Only you (and your supervisor, to co-sign) can read it. It's never shared in the portal, included in record exports or releases, sent to the AI assistant or used on claims.";

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  none: 'None noted',
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
};

export const notesApi = {
  formats: () => api<NoteFormat[]>('/notes/formats'),
  /** A page of notes, newest first, with how many match in all. */
  list: (params: NoteListParams = {}) => apiPage<NoteSummary>('/notes', { query: { ...params } }),
  get: (id: number) => api<Note>(`/notes/${id}`),
  create: (input: NoteCreate) => api<Note>('/notes', { body: input }),
  update: (id: number, changes: NoteUpdate) => api<Note>(`/notes/${id}`, { method: 'PATCH', body: changes }),
  sign: (id: number) => api<Note>(`/notes/${id}/sign`, { method: 'POST' }),
  /** Return a signed note to draft; the reason is saved with its next signature. */
  unlock: (id: number, reason: string) => api<Note>(`/notes/${id}/unlock`, { body: { reason } }),
  revisions: (id: number) => api<NoteRevision[]>(`/notes/${id}/revisions`),
  addenda: (id: number) => api<NoteAddendum[]>(`/notes/${id}/addenda`),
  addAddendum: (id: number, content: string) => api<NoteAddendum>(`/notes/${id}/addenda`, { body: { content } }),
  remove: (id: number) => api<void>(`/notes/${id}`, { method: 'DELETE' }),
  /** Start a draft for each client in the session who has none from me yet; returns the new drafts. */
  createGroup: (appointmentId: number, input: GroupNoteCreate) =>
    api<Note[]>(`/appointments/${appointmentId}/group-notes`, { body: input }),
  /** Sign all of my drafts for an appointment at once; returns them. */
  signSession: (appointmentId: number) =>
    api<Note[]>(`/appointments/${appointmentId}/notes/sign`, { method: 'POST' }),
  /** Supervisees' notes waiting for my co-signature, oldest signature first. */
  cosignQueue: () => api<NoteSummary[]>('/notes/cosign-queue'),
  cosign: (id: number) => api<Note>(`/notes/${id}/cosign`, { method: 'POST' }),
  requestChanges: (id: number, comment: string) =>
    api<Note>(`/notes/${id}/request-changes`, { body: { comment } }),
  backlog: async (): Promise<NoteBacklog> => {
    const data = await api<NoteBacklog>('/dashboard');
    return {
      draft_notes: data.draft_notes,
      appointments_missing_notes: data.appointments_missing_notes,
      notes_awaiting_cosign: data.notes_awaiting_cosign,
    };
  },
};

export const noteKeys = {
  all: ['notes'] as const,
  formats: ['notes', 'formats'] as const,
  lists: ['notes', 'list'] as const,
  /** One page of notes (a plain query). */
  list: (params: NoteListParams) => ['notes', 'list', params] as const,
  /** A paginated note list (an infinite query). */
  pages: (params: NoteListParams) => ['notes', 'list', 'pages', params] as const,
  detail: (id: number) => ['notes', 'detail', id] as const,
  revisions: (id: number) => ['notes', 'revisions', id] as const,
  addenda: (id: number) => ['notes', 'addenda', id] as const,
  cosignQueue: ['notes', 'cosign-queue'] as const,
  backlog: ['notes', 'backlog'] as const,
};
