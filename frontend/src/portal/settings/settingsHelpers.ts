import type { TaxIdType } from '../../api/practice';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/;

/** A booking-link slug built from free text ("Dr. Dana Lee" -> "dr-dana-lee"). */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/** The API's slug rule: lowercase letters, digits and inner hyphens, 1 or 3 to 80 characters. */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function isValidNpi(npi: string): boolean {
  return /^\d{10}$/.test(npi);
}

/** A provider taxonomy code: nine letters or digits and a final X (for example 101YM0800X). */
export function isValidTaxonomy(code: string): boolean {
  return /^[0-9A-Z]{9}X$/.test(code);
}

/** An EIN (12-3456789) or SSN (123-45-6789), with or without dashes. */
export function isValidTaxId(taxId: string, type: TaxIdType): boolean {
  return type === 'EIN' ? /^\d{2}-?\d{7}$/.test(taxId) : /^\d{3}-?\d{2}-?\d{4}$/.test(taxId);
}

export function bookingUrl(origin: string, slug: string): string {
  return `${origin}/book/${slug}`;
}

/** Preset choices plus the current value (if it's not a preset), in ascending order. */
export function numberOptions(presets: number[], current: number): number[] {
  return Array.from(new Set([...presets, current])).sort((a, b) => a - b);
}

export function hoursLabel(hours: number): string {
  if (hours % 24 === 0 && hours >= 24) {
    const days = hours / 24;
    return `${hours} hours (${days} ${days === 1 ? 'day' : 'days'})`;
  }
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

export function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const picked = {} as Pick<T, K>;
  for (const key of keys) picked[key] = source[key];
  return picked;
}
