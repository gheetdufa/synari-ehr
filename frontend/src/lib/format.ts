/** Display helpers. All API datetimes are UTC ISO strings; show them in the practice's zone. */

let displayCurrency = 'USD';

/** Set the currency used for amounts (the server's configured payment currency). */
export function setDisplayCurrency(currency: string): void {
  if (currency) displayCurrency = currency.toUpperCase();
}

export function formatMoney(cents: number, currency = displayCurrency): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** Parse a user-typed dollar amount ("45", "45.5", "$1,200.00") into cents, or null. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function formatDate(iso: string, timeZone?: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

export function formatDateTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** A plain date ("2026-10-05", no time) formatted without time-zone shifting. */
export function formatPlainDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

export function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

export interface PersonName {
  first_name: string;
  last_name: string;
  preferred_name?: string;
}

/** "Alex Rivera", or "Lex (Alex) Rivera" when a preferred name is set. */
export function fullName(person: PersonName): string {
  if (person.preferred_name && person.preferred_name !== person.first_name) {
    return `${person.preferred_name} (${person.first_name}) ${person.last_name}`;
  }
  return `${person.first_name} ${person.last_name}`;
}

export function displayFirstName(person: PersonName): string {
  return person.preferred_name || person.first_name;
}

export function initials(person: PersonName): string {
  return `${displayFirstName(person)[0] ?? ''}${person.last_name[0] ?? ''}`.toUpperCase();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The browser's IANA time zone, used as the default for new practices. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
}
