import { useState, useSyncExternalStore } from 'react';
import type { Note, NoteFormatId, NoteType, NoteUpdate, RiskLevel } from '../../api/notes';

/** How long typing must pause before a draft is saved. */
export const AUTOSAVE_DELAY_MS = 1500;

/** The parts of a draft note its author edits. */
export interface EditableNote {
  title: string;
  note_type: NoteType;
  format: NoteFormatId;
  appointment_id: number | null;
  sections: Record<string, string>;
  content: string;
  risk_level: RiskLevel;
  risk_flags: string[];
}

export function toEditable(note: Note): EditableNote {
  return {
    title: note.title,
    note_type: note.note_type,
    format: note.format,
    appointment_id: note.appointment_id,
    sections: note.sections,
    content: note.content,
    risk_level: note.risk_level,
    risk_flags: note.risk_flags,
  };
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * The PATCH body that brings the saved note up to date with the draft, or null when nothing
 * changed. Format, sections and content always travel together so the server can validate the
 * text against the format. A blank title is never sent (the server requires one).
 */
export function notePatch(saved: EditableNote, draft: EditableNote): NoteUpdate | null {
  const patch: NoteUpdate = {};
  const title = draft.title.trim();
  if (title && title !== saved.title.trim()) patch.title = title;
  if (draft.note_type !== saved.note_type) patch.note_type = draft.note_type;
  if (draft.appointment_id !== saved.appointment_id) patch.appointment_id = draft.appointment_id;
  if (draft.risk_level !== saved.risk_level) patch.risk_level = draft.risk_level;
  if (!sameList(draft.risk_flags, saved.risk_flags)) patch.risk_flags = draft.risk_flags;
  if (
    draft.format !== saved.format ||
    draft.content !== saved.content ||
    !sameRecord(draft.sections, saved.sections)
  ) {
    patch.format = draft.format;
    patch.sections = draft.sections;
    patch.content = draft.content;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export type AutosaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

export interface AutosaveSnapshot<T> {
  /** What the editor shows. */
  value: T;
  /** The last value the server accepted. */
  saved: T;
  status: AutosaveStatus;
  error: unknown;
  lastSavedAt: number | null;
}

interface AutosaverOptions<T, P> {
  initial: T;
  /** The change set to send, or null when `value` needs no save. */
  diff: (saved: T, value: T) => P | null;
  save: (patch: P, value: T) => Promise<void>;
  delayMs: number;
}

/**
 * Debounced, serialized saving of an edited value. Edits schedule a save after a pause;
 * `flush()` saves right away. Saves never overlap: a save requested while one is in flight
 * runs after it, with whatever changed in the meantime. Failed saves keep the edits and are
 * retried on the next edit or flush.
 */
export class Autosaver<T, P> {
  private value: T;
  private saved: T;
  private saving = false;
  private error: unknown = null;
  private lastSavedAt: number | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private snapshot: AutosaveSnapshot<T>;

  constructor(private readonly options: AutosaverOptions<T, P>) {
    this.value = options.initial;
    this.saved = options.initial;
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AutosaveSnapshot<T> => this.snapshot;

  isDirty(): boolean {
    return this.options.diff(this.saved, this.value) !== null;
  }

  /** Replace the edited value and schedule a save. */
  update(value: T): void {
    this.value = value;
    this.clearTimer();
    if (!this.stopped && this.isDirty()) {
      this.timer = setTimeout(() => void this.flush(), this.options.delayMs);
    }
    this.emit();
  }

  /** Save now. Resolves true once everything edited so far is saved. */
  flush(): Promise<boolean> {
    this.clearTimer();
    const run = this.chain.then(() => this.saveOnce());
    this.chain = run;
    return run;
  }

  /** Stop saving (the note was signed, locked elsewhere or is being deleted). */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  resume(): void {
    this.stopped = false;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private async saveOnce(): Promise<boolean> {
    if (this.stopped) return !this.isDirty();
    const patch = this.options.diff(this.saved, this.value);
    if (patch === null) {
      if (this.error !== null) {
        this.error = null;
        this.emit();
      }
      return true;
    }
    const sent = this.value;
    this.saving = true;
    this.emit();
    try {
      await this.options.save(patch, sent);
      this.saved = sent;
      this.error = null;
      this.lastSavedAt = Date.now();
      return !this.isDirty();
    } catch (error) {
      this.error = error;
      return false;
    } finally {
      this.saving = false;
      this.emit();
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private buildSnapshot(): AutosaveSnapshot<T> {
    const dirty = this.isDirty();
    let status: AutosaveStatus = 'saved';
    if (this.saving) status = 'saving';
    else if (dirty && this.error !== null) status = 'error';
    else if (dirty) status = 'dirty';
    return { value: this.value, saved: this.saved, status, error: this.error, lastSavedAt: this.lastSavedAt };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    this.listeners.forEach((listener) => listener());
  }
}

/** Subscribe a component to an Autosaver created once for its lifetime. */
export function useAutosaver<T, P>(create: () => Autosaver<T, P>): [AutosaveSnapshot<T>, Autosaver<T, P>] {
  const [saver] = useState(create);
  const snapshot = useSyncExternalStore(saver.subscribe, saver.getSnapshot);
  return [snapshot, saver];
}
