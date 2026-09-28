import type { ClientFormSummary } from '../../api/forms';
import { Badge } from '../../ui/Display';

/** Pending (not opened yet), Viewed (opened, not submitted) or Completed. */
export function formStatus(form: Pick<ClientFormSummary, 'status' | 'viewed_at'>): 'Pending' | 'Viewed' | 'Completed' {
  if (form.status === 'completed') return 'Completed';
  return form.viewed_at ? 'Viewed' : 'Pending';
}

const TONES = { Pending: 'warning', Viewed: 'info', Completed: 'success' } as const;

export function FormStatusBadge({ form }: { form: Pick<ClientFormSummary, 'status' | 'viewed_at'> }) {
  const status = formStatus(form);
  return <Badge tone={TONES[status]}>{status}</Badge>;
}
