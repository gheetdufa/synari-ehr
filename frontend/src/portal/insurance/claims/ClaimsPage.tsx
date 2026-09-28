import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { claimsApi, claimsKeys, type Claim, type ClaimFilters } from '../../../api/claims';
import { LinkButton } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { PageHeader, Tabs, type TabItem } from '../../../ui/Display';
import { BillingSubNav } from '../BillingSubNav';
import { useClaimsRealtime } from '../hooks';
import { CLAIM_STATUSES } from '../labels';
import { ClaimFiltersBar } from './ClaimFiltersBar';
import { ClaimsList, type StatusFilter } from './ClaimsList';
import { UnbilledQueue } from './UnbilledQueue';

type View = 'ready' | 'claims';

function statusFrom(value: string | null): StatusFilter {
  return CLAIM_STATUSES.find((status) => status === value) ?? 'all';
}

/** Insurance claims: sessions ready to file, and claims by status. Synced to `?view=&status=`. */
export default function ClaimsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'claims' ? 'claims' : 'ready';
  const status = statusFrom(params.get('status'));
  const [filters, setFilters] = useState<ClaimFilters>({});
  useClaimsRealtime();

  // Only the count is needed here, so ask for the smallest page.
  const readyCount = useQuery({
    queryKey: claimsKeys.unbilledCount(filters),
    queryFn: () => claimsApi.unbilled({ ...filters, limit: 1 }),
    select: (page) => page.total,
  });

  const go = (nextView: View, nextStatus: StatusFilter = 'all') =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('view', nextView);
        if (nextView === 'claims' && nextStatus !== 'all') next.set('status', nextStatus);
        else next.delete('status');
        return next;
      },
      { replace: true },
    );

  const created = (claims: Claim[]) => {
    if (claims.length === 1) navigate(`/portal/billing/claims/${claims[0].id}`);
    else go('claims', 'draft');
  };

  const tabs: TabItem<View>[] = [
    { id: 'ready', label: 'Ready to file', count: readyCount.data },
    { id: 'claims', label: 'Claims' },
  ];

  return (
    <div>
      <BillingSubNav />
      <PageHeader
        title="Insurance claims"
        description="File claims for attended sessions and follow them until they're paid."
        actions={
          <LinkButton to="/portal/settings?tab=insurance" variant="secondary" icon={<Settings2 className="h-4 w-4" />}>
            Insurance settings
          </LinkButton>
        }
      />
      <Card>
        <div className="px-4 pt-2 sm:px-5">
          <Tabs tabs={tabs} active={view} onChange={(next) => go(next)} />
        </div>
        <ClaimFiltersBar value={filters} onChange={setFilters} />
        <div role="tabpanel" aria-label={view === 'ready' ? 'Ready to file' : 'Claims'}>
          {view === 'ready' ? (
            <UnbilledQueue filters={filters} onCreated={created} />
          ) : (
            <ClaimsList filters={filters} status={status} onStatusChange={(next) => go('claims', next)} />
          )}
        </div>
      </Card>
    </div>
  );
}
