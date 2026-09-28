import type { FormField } from '../../api/forms';
import { sanitizeDraftAnswers, type DraftAnswers } from '../../shared/forms/answers';

/**
 * In-progress answers are kept in sessionStorage (this browser tab only, gone when it closes)
 * so a refresh or a failed submit never loses them. They are cleared once the form is submitted.
 */
export interface StoredDraft {
  answers: DraftAnswers;
  signatureName: string;
}

const PREFIX = 'synari.form-draft';

export function draftStorageKey(clientId: number, formId: number): string {
  return `${PREFIX}.${clientId}.${formId}`;
}

export function loadDraft(key: string, fields: FormField[]): StoredDraft {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { answers: {}, signatureName: '' };
    const parsed = JSON.parse(raw) as { answers?: unknown; signatureName?: unknown };
    return {
      answers: sanitizeDraftAnswers(fields, parsed.answers),
      signatureName: typeof parsed.signatureName === 'string' ? parsed.signatureName : '',
    };
  } catch {
    return { answers: {}, signatureName: '' };
  }
}

export function saveDraft(key: string, draft: StoredDraft): void {
  try {
    const empty = Object.keys(draft.answers).length === 0 && !draft.signatureName;
    if (empty) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage can be full or blocked (private browsing); the form still works without it.
  }
}

export function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export function hasDraft(key: string): boolean {
  try {
    return sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}
