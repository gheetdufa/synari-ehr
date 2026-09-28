/** Common IANA time zones for practice and client settings, with friendly labels. */
const COMMON_TIME_ZONES: { value: string; label: string }[] = [
  { value: 'America/New_York', label: 'Eastern Time (New York)' },
  { value: 'America/Chicago', label: 'Central Time (Chicago)' },
  { value: 'America/Denver', label: 'Mountain Time (Denver)' },
  { value: 'America/Phoenix', label: 'Mountain Time, no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska Time (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (Honolulu)' },
  { value: 'America/Puerto_Rico', label: 'Atlantic Time (Puerto Rico)' },
  { value: 'America/Halifax', label: 'Atlantic Time (Halifax)' },
  { value: 'America/St_Johns', label: "Newfoundland Time (St. John's)" },
  { value: 'America/Toronto', label: 'Eastern Time (Toronto)' },
  { value: 'America/Vancouver', label: 'Pacific Time (Vancouver)' },
  { value: 'America/Mexico_City', label: 'Central Time (Mexico City)' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Dublin', label: 'Dublin' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Asia/Kolkata', label: 'India (Kolkata)' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Pacific/Auckland', label: 'Auckland' },
  { value: 'UTC', label: 'UTC' },
];

/** Options for a time-zone select, always including `current` so an existing value shows. */
export function timeZoneOptions(current?: string | null): { value: string; label: string }[] {
  if (!current || COMMON_TIME_ZONES.some((zone) => zone.value === current)) return COMMON_TIME_ZONES;
  return [{ value: current, label: current.replace(/_/g, ' ') }, ...COMMON_TIME_ZONES];
}

export function timeZoneLabel(value: string): string {
  return COMMON_TIME_ZONES.find((zone) => zone.value === value)?.label ?? value.replace(/_/g, ' ');
}
