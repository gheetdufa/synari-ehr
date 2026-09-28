import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosaver, notePatch, type EditableNote } from './autosave';

const base: EditableNote = {
  title: 'Progress note – Oct 5, 2026',
  note_type: 'progress',
  format: 'SOAP',
  appointment_id: 7,
  sections: { subjective: 'S', objective: '', assessment: '', plan: '' },
  content: '',
  risk_level: 'none',
  risk_flags: [],
};

describe('notePatch', () => {
  it('is null when nothing changed', () => {
    expect(notePatch(base, { ...base, sections: { ...base.sections } })).toBeNull();
  });

  it('sends format, sections and content together when any text changes', () => {
    const next = { ...base, sections: { ...base.sections, plan: 'Weekly' } };
    expect(notePatch(base, next)).toEqual({ format: 'SOAP', sections: next.sections, content: '' });
  });

  it('sends only changed metadata', () => {
    expect(notePatch(base, { ...base, note_type: 'intake', risk_level: 'low', appointment_id: null })).toEqual({
      note_type: 'intake',
      risk_level: 'low',
      appointment_id: null,
    });
    expect(notePatch(base, { ...base, risk_flags: ['Flag'] })).toEqual({ risk_flags: ['Flag'] });
  });

  it('trims titles and never sends a blank one', () => {
    expect(notePatch(base, { ...base, title: '  Intake  ' })).toEqual({ title: 'Intake' });
    expect(notePatch(base, { ...base, title: '   ' })).toBeNull();
    expect(notePatch(base, { ...base, title: `${base.title} ` })).toBeNull();
  });
});

type Value = { text: string };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSaver(save: (patch: string, value: Value) => Promise<void>) {
  return new Autosaver<Value, string>({
    initial: { text: 'a' },
    diff: (saved, value) => (saved.text === value.text ? null : value.text),
    save,
    delayMs: 1500,
  });
}

describe('Autosaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks edits dirty and saves once typing pauses', async () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = makeSaver(save);
    expect(saver.getSnapshot().status).toBe('saved');

    saver.update({ text: 'ab' });
    expect(saver.getSnapshot().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1000);
    saver.update({ text: 'abc' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc', { text: 'abc' });
    expect(saver.getSnapshot().status).toBe('saved');
    expect(saver.getSnapshot().lastSavedAt).not.toBeNull();
    expect(saver.getSnapshot().saved).toEqual({ text: 'abc' });
  });

  it('does not save when an edit is reverted', async () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = makeSaver(save);
    saver.update({ text: 'ab' });
    saver.update({ text: 'a' });
    expect(saver.getSnapshot().status).toBe('saved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
  });

  it('flushes immediately and never overlaps saves', async () => {
    const first = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const saver = makeSaver(save);

    saver.update({ text: 'ab' });
    const firstFlush = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.getSnapshot().status).toBe('saving');

    saver.update({ text: 'abc' });
    const secondFlush = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve();
    expect(await firstFlush).toBe(false);
    expect(await secondFlush).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('abc', { text: 'abc' });
    expect(saver.getSnapshot().status).toBe('saved');
  });

  it('keeps edits after a failed save and retries on the next flush', async () => {
    const failure = new Error('offline');
    const save = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const saver = makeSaver(save);

    saver.update({ text: 'ab' });
    expect(await saver.flush()).toBe(false);
    expect(saver.getSnapshot().status).toBe('error');
    expect(saver.getSnapshot().error).toBe(failure);
    expect(saver.getSnapshot().value).toEqual({ text: 'ab' });

    expect(await saver.flush()).toBe(true);
    expect(saver.getSnapshot().status).toBe('saved');
    expect(saver.getSnapshot().error).toBeNull();
  });

  it('stops saving once stopped', async () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = makeSaver(save);
    saver.update({ text: 'ab' });
    saver.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await saver.flush()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(saver.isStopped()).toBe(true);

    saver.resume();
    expect(await saver.flush()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on every change', () => {
    const saver = makeSaver(() => Promise.resolve());
    const listener = vi.fn();
    const unsubscribe = saver.subscribe(listener);
    saver.update({ text: 'ab' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    saver.update({ text: 'abc' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
