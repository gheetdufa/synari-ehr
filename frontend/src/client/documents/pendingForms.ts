import type { PortalFormSummary } from '../../api/forms';

/** Forms still to complete, in the order they were shared (so intake comes before later forms). */
export function pendingInOrder(forms: PortalFormSummary[]): PortalFormSummary[] {
  return forms
    .filter((form) => form.status === 'pending')
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id - b.id);
}
