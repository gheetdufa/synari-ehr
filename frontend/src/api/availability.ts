import { api } from './client';
import type { LocationType } from './appointments';

/** 0 = Monday ... 6 = Sunday, matching the API. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** One weekly block of bookable time, as wall-clock "HH:MM" in the clinician's time zone. */
export interface AvailabilityBlockInput {
  weekday: Weekday;
  start_time: string;
  end_time: string;
  location_type: LocationType;
  /** The office (or video office) the block's appointments take place in, if any. */
  location_id: number | null;
}

export interface AvailabilityBlock extends AvailabilityBlockInput {
  id: number;
  clinician_id: number;
}

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  0: 'Monday',
  1: 'Tuesday',
  2: 'Wednesday',
  3: 'Thursday',
  4: 'Friday',
  5: 'Saturday',
  6: 'Sunday',
};

/** Each clinician's weekly availability; other clinicians' need the schedule-all permission. */
export const availabilityApi = {
  get: (clinicianId: number) =>
    api<AvailabilityBlock[]>('/availability', { query: { clinician_id: clinicianId } }),
  /** Replaces the clinician's whole weekly set. */
  replace: (clinicianId: number, blocks: AvailabilityBlockInput[]) =>
    api<AvailabilityBlock[]>('/availability', { method: 'PUT', body: { blocks }, query: { clinician_id: clinicianId } }),
};

export const availabilityKeys = {
  all: ['availability'] as const,
  clinician: (clinicianId: number) => ['availability', clinicianId] as const,
};
