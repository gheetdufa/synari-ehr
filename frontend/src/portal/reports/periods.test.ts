import { describe, expect, it } from 'vitest';
import { periodError, presetPeriod } from './periods';

describe('presetPeriod', () => {
  it.each([
    ['this_month', '2026-09-26', { start: '2026-09-01', end: '2026-09-30' }],
    ['this_month', '2028-02-10', { start: '2028-02-01', end: '2028-02-29' }],
    ['last_month', '2026-09-26', { start: '2026-08-01', end: '2026-08-31' }],
    ['last_month', '2026-01-05', { start: '2025-12-01', end: '2025-12-31' }],
    ['last_month', '2026-03-31', { start: '2026-02-01', end: '2026-02-28' }],
    ['this_year', '2026-09-26', { start: '2026-01-01', end: '2026-12-31' }],
  ] as const)('%s on %s', (preset, today, period) => {
    expect(presetPeriod(preset, today)).toEqual(period);
  });
});

describe('periodError', () => {
  it.each([
    [{ start: '2026-09-01', end: '2026-09-30' }, null],
    [{ start: '2026-09-01', end: '2026-09-01' }, null],
    [{ start: '2023-01-01', end: '2026-01-03' }, null],
    [{ start: '', end: '2026-09-30' }, 'Pick a start and end date.'],
    [{ start: '2026-09-01', end: '' }, 'Pick a start and end date.'],
    [{ start: '2026-09-02', end: '2026-09-01' }, 'The end date is before the start date.'],
    [{ start: '2023-01-01', end: '2026-01-04' }, 'Choose a period of three years or less.'],
  ])('%j -> %s', (period, error) => {
    expect(periodError(period)).toBe(error);
  });
});
