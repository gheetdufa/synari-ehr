import { api, ApiError } from './client';
import type { NoteFormatId, NoteType } from './notes';

/** A drafted note for the clinician to review. Nothing is saved by the server. */
export interface NoteProposal {
  format: NoteFormatId;
  /** Every section id in format order for structured formats; empty for FREEFORM. */
  sections: Record<string, string>;
  /** The note text for FREEFORM; empty for structured formats. */
  content: string;
  risk_flags: string[];
}

export interface NoteGenerateInput {
  client_id: number;
  appointment_id?: number | null;
  format?: NoteFormatId;
  note_type?: NoteType;
  source_text: string;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AssistantInput {
  messages: ChatMessage[];
  client_id?: number | null;
}

/** Server limits for AI requests. */
export const MAX_SOURCE_CHARS = 60_000;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_MESSAGES = 40;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const aiApi = {
  generateNote: (input: NoteGenerateInput, signal?: AbortSignal) =>
    api<NoteProposal>('/ai/notes/generate', { body: input, signal }),
  assistant: (input: AssistantInput, signal?: AbortSignal) =>
    api<{ reply: string }>('/ai/assistant', { body: input, signal }),
  transcribe: (audio: Blob, filename: string, signal?: AbortSignal) => {
    const form = new FormData();
    form.append('file', audio, filename);
    return api<{ text: string }>('/ai/transcribe', { method: 'POST', body: form, signal });
  },
};

/** True for the error fetch throws when a request is canceled with an AbortController. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * A readable explanation for a failed AI request: not configured (503), the provider failed (502),
 * not a clinician (403), no clinical access to the client (404), or the client isn't in the
 * linked appointment (422).
 */
export function aiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) return "AI features aren't set up on this server, so this can't run right now.";
    if (error.status === 502 && error.detail === null) return "The AI service couldn't complete the request. Try again shortly.";
    if (error.status === 403) return 'AI note drafting is only for clinicians who write notes.';
    if (error.status === 404) return "You can't open this client's clinical record, so Synari can't use it. Choose one of your clients.";
    if (error.status === 422 && typeof error.detail === 'string' && error.detail.includes('appointment')) {
      return "This client wasn't in the linked appointment. Link the right session (or none) and try again.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
