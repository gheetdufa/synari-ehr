import type { BillingType, ClientContact, ClientDetail, ClientStatus } from '../../api/clients';

export const CLIENT_STATUS_LABELS: Record<ClientStatus, string> = {
  active: 'Active',
  prospective: 'Prospective',
  inactive: 'Inactive',
  archived: 'Archived',
};

export const CLIENT_STATUS_TONES: Record<ClientStatus, 'success' | 'info' | 'neutral' | 'warning'> = {
  active: 'success',
  prospective: 'info',
  inactive: 'neutral',
  archived: 'warning',
};

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  self_pay: 'Self-pay',
  insurance: 'Insurance',
};

/** A contact's name ("Pat Rivera", or just "Pat" when no last name was given). */
export function contactName(contact: Pick<ClientContact, 'first_name' | 'last_name'>): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
}

/** Whether the client's portal is open (turned on, and the client is active or prospective). */
export function portalOpen(client: Pick<ClientDetail, 'portal_enabled' | 'status'>): boolean {
  return client.portal_enabled && (client.status === 'active' || client.status === 'prospective');
}

/** "YYYY-MM-DD" for the calendar date it currently is in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Whole years between a "YYYY-MM-DD" birth date and a "YYYY-MM-DD" day. */
export function ageOn(dateOfBirth: string, today: string): number {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split('-').map(Number);
  const [year, month, day] = today.split('-').map(Number);
  const hadBirthday = month > birthMonth || (month === birthMonth && day >= birthDay);
  return year - birthYear - (hadBirthday ? 0 : 1);
}

export const CLIENT_TABS = [
  'overview',
  'appointments',
  'notes',
  'documents',
  'billing',
  'estimates',
  'privacy',
  'access',
] as const;
export type ClientTab = (typeof CLIENT_TABS)[number];

/** The chart tab named by `?tab=`; "forms" is accepted as an alias for documents. */
export function clientTabFrom(value: string | null): ClientTab {
  if (value === 'forms') return 'documents';
  return (CLIENT_TABS as readonly string[]).includes(value ?? '') ? (value as ClientTab) : 'overview';
}

const ICD10_PATTERN = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;

/** Same shape check the API applies, for instant feedback while typing. */
export function isIcd10(code: string): boolean {
  return ICD10_PATTERN.test(code.trim().toUpperCase());
}

export type ClientStatusFilter = ClientStatus | 'all';

export const STATUS_FILTERS: { value: ClientStatusFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'prospective', label: 'Prospective' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All (not archived)' },
];

export function statusFilterFrom(value: string | null): ClientStatusFilter {
  return STATUS_FILTERS.some((option) => option.value === value) ? (value as ClientStatusFilter) : 'active';
}
