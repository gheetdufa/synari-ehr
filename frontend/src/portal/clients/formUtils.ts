import { ApiError } from '../../api/client';

/**
 * The entries of `next` whose values differ from the same keys in `current`, so a PATCH only
 * carries what the user actually changed. Arrays and objects are compared by value.
 */
export function changedFields<T extends object, U extends Partial<T>>(current: T, next: U): Partial<U> {
  const changes: Partial<U> = {};
  for (const key of Object.keys(next) as (keyof U & keyof T)[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) changes[key] = next[key];
  }
  return changes;
}

function cleanMessage(message: string): string {
  const text = message.replace(/^Value error,\s*/i, '').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Field-level messages from a 422 validation response, keyed by dotted path without the
 * leading "body" (for example `email` or `diagnosis_codes.0.code`). Empty for other errors.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.detail)) return {};
  const errors: Record<string, string> = {};
  for (const item of error.detail as { loc?: unknown; msg?: unknown }[]) {
    if (!Array.isArray(item.loc) || typeof item.msg !== 'string') continue;
    const path = item.loc.filter((part) => part !== 'body').join('.');
    if (path && !errors[path]) errors[path] = cleanMessage(item.msg);
  }
  return errors;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** Trimmed text, or null when blank (for optional API fields that reject empty strings). */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Cents as a plain dollar amount for an input ("125.5" -> "125.50"); blank for null. */
export function centsToInput(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}
