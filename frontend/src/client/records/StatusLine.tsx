import { Badge } from '../../ui/Display';
import type { StatusView } from './recordStatus';

/** A request's status badge with its one-line explanation. */
export function StatusLine({ status }: { status: StatusView }) {
  return (
    <div className="mt-2 space-y-1">
      <Badge tone={status.tone}>{status.label}</Badge>
      <p className="text-sm text-sage-600">{status.detail}</p>
    </div>
  );
}
