import type { ReportPeriod } from '../../api/reports';

/** Longest period the API reports on (three years). */
export const MAX_PERIOD_DAYS = 366 * 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export type PeriodPreset = 'this_month' | 'last_month' | 'this_year' | 'custom';

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'this_year', label: 'This year' },
  { id: 'custom', label: 'Custom' },
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The whole calendar month (1-12) as a period. */
function monthPeriod(year: number, month: number): ReportPeriod {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/** The full month or year a preset covers, relative to `today` (YYYY-MM-DD in the practice's zone). */
export function presetPeriod(preset: Exclude<PeriodPreset, 'custom'>, today: string): ReportPeriod {
  const [year, month] = today.split('-').map(Number);
  if (preset === 'this_year') return { start: `${year}-01-01`, end: `${year}-12-31` };
  if (preset === 'this_month') return monthPeriod(year, month);
  return month === 1 ? monthPeriod(year - 1, 12) : monthPeriod(year, month - 1);
}

/** Why a chosen period can't be reported on (the API's rules), or null when it's fine. */
export function periodError({ start, end }: ReportPeriod): string | null {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return 'Pick a start and end date.';
  if (end < start) return 'The end date is before the start date.';
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
  if (days > MAX_PERIOD_DAYS) return 'Choose a period of three years or less.';
  return null;
}
