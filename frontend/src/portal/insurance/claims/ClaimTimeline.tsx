import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ClaimEvent } from '../../../api/claims';
import { teamApi, teamKeys } from '../../../api/team';
import { useCan, useSession } from '../../../auth/StaffAuth';
import { formatDateTime } from '../../../lib/format';
import { Card, CardHeader } from '../../../ui/Card';
import { Badge } from '../../../ui/Display';
import { CLAIM_EVENT_LABELS, CLAIM_EVENT_TONES } from '../labels';

function numberFrom(data: ClaimEvent['data'], key: string): number | null {
  const value = data?.[key];
  return typeof value === 'number' ? value : null;
}

/** The claim's history, newest first: who did what, and what the payer said. */
export function ClaimTimeline({ events }: { events: ClaimEvent[] }) {
  const { staff } = useSession();
  const seesPayments = useCan('billing_all');
  const team = useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list });
  const names = new Map((team.data ?? []).map((member) => [member.id, member.display_name]));
  const newestFirst = [...events].reverse();

  return (
    <Card>
      <CardHeader title="History" />
      <ol className="divide-y divide-sage-100" aria-label="Claim history">
        {newestFirst.map((event) => {
          const claimId = numberFrom(event.data, 'claim_id');
          const remittanceId = numberFrom(event.data, 'remittance_id');
          const who =
            event.staff_id === null ? '' : event.staff_id === staff.id ? 'You' : names.get(event.staff_id) ?? 'A team member';
          return (
            <li key={event.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:gap-4">
              <div className="shrink-0 sm:w-36">
                <Badge tone={CLAIM_EVENT_TONES[event.kind] ?? 'neutral'}>{CLAIM_EVENT_LABELS[event.kind] ?? event.kind}</Badge>
              </div>
              <div className="min-w-0 flex-1 text-sm">
                <p className="text-sage-900">{event.message}</p>
                <p className="text-xs text-sage-500">
                  {formatDateTime(event.created_at, staff.time_zone)}
                  {who && ` · ${who}`}
                </p>
                {(claimId !== null || (remittanceId !== null && seesPayments)) && (
                  <p className="mt-1 flex flex-wrap gap-3">
                    {claimId !== null && (
                      <Link to={`/portal/billing/claims/${claimId}`} className="text-sm font-medium text-primary-700 hover:underline">
                        View claim
                      </Link>
                    )}
                    {remittanceId !== null && seesPayments && (
                      <Link
                        to={`/portal/billing/remittances/${remittanceId}`}
                        className="text-sm font-medium text-primary-700 hover:underline"
                      >
                        View insurance payment
                      </Link>
                    )}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
