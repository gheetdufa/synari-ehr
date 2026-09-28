import type { Page } from '../api/client';

/** A list endpoint's response for tests: these rows, and `total` matching rows in all. */
export function page<T>(items: T[], total = items.length): Page<T> {
  return { items, total };
}
