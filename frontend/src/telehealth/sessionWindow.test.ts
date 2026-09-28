import { describe, expect, it } from 'vitest';
import { formatElapsed, hostJoinWindow, waitingLabel } from './sessionWindow';

const START = '2026-10-05T14:00:00Z';
const END = '2026-10-05T14:50:00Z';
const at = (iso: string) => new Date(iso).getTime();

describe('hostJoinWindow', () => {
  it.each([
    ['2026-10-05T12:59:59Z', 'too_early'],
    ['2026-10-05T13:00:00Z', 'open'],
    ['2026-10-05T14:20:00Z', 'open'],
    ['2026-10-05T15:50:00Z', 'open'],
    ['2026-10-05T15:50:01Z', 'closed'],
  ])('at %s is %s', (now, expected) => {
    expect(hostJoinWindow(START, END, at(now)).state).toBe(expected);
  });

  it('reports when the window opens and closes', () => {
    const window = hostJoinWindow(START, END, at(START));
    expect(window.opensAt.toISOString()).toBe('2026-10-05T13:00:00.000Z');
    expect(window.closesAt.toISOString()).toBe('2026-10-05T15:50:00.000Z');
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [7_400, '0:07'],
    [723_000, '12:03'],
    [3_723_000, '1:02:03'],
    [-5_000, '0:00'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe('waitingLabel', () => {
  const since = '2026-10-05T14:00:00Z';
  it.each([
    ['2026-10-05T14:00:30Z', 'Just arrived'],
    ['2026-10-05T14:04:10Z', 'Waiting 4 min'],
    ['2026-10-05T15:00:00Z', 'Waiting 1 hr'],
    ['2026-10-05T15:05:00Z', 'Waiting 1 hr 5 min'],
  ])('at %s is "%s"', (now, expected) => {
    expect(waitingLabel(since, at(now))).toBe(expected);
  });
});
