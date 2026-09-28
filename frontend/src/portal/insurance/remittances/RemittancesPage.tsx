import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Landmark, Lock, Upload } from 'lucide-react';
import { remittanceKeys, remittancesApi, type RemittanceStatus } from '../../../api/remittances';
import { useCan, useSession } from '../../../auth/StaffAuth';
import { formatDate, formatMoney, formatPlainDate } from '../../../lib/format';
import { usePagedQuery } from '../../../lib/paging';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Badge, EmptyState, ErrorState, PageHeader, Table, Tabs, Td, Th, type TabItem } from '../../../ui/Display';
import { LoadMore } from '../../../ui/LoadMore';
import { SectionSpinner } from '../../../ui/Spinner';
import { RemittanceStatusBadge } from '../Badges';
import { BillingSubNav } from '../BillingSubNav';
import { useClaimsRealtime } from '../hooks';
import { PAYMENT_METHOD_LABELS, REMITTANCE_STATUS_LABELS } from '../labels';
import { UploadResponseFileDialog } from './UploadResponseFileDialog';

type StatusFilter = RemittanceStatus | 'all';
const STATUSES: RemittanceStatus[] = ['needs_review', 'unposted', 'posted'];

function statusFrom(value: string | null): StatusFilter {
  return STATUSES.find((status) => status === value) ?? 'all';
}

/** Shown instead of insurance payments to people without practice-wide billing. */
export function RemittancesLocked() {
  return (
    <Card>
      <EmptyState
        icon={<Lock />}
        title="Not available for your role"
        description="Insurance payments cover many clients at once, so they need practice-wide billing access."
      />
    </Card>
  );
}

function RemittanceList() {
  const { staff } = useSession();
  const [params, setParams] = useSearchParams();
  const status = statusFrom(params.get('status'));
  const [uploading, setUploading] = useState(false);
  const statusParam = status === 'all' ? undefined : status;
  const remittances = usePagedQuery({
    queryKey: remittanceKeys.list(statusParam),
    fetchPage: (page) => remittancesApi.list({ status: statusParam, ...page }),
  });
  // What needs someone's attention is counted whichever tab is open (one row is enough to get the count).
  const needsReview = useQuery({
    queryKey: remittanceKeys.count('needs_review'),
    queryFn: () => remittancesApi.list({ status: 'needs_review', limit: 1 }),
    select: (page) => page.total,
  });

  const choose = (next: StatusFilter) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === 'all') updated.delete('status');
        else updated.set('status', next);
        return updated;
      },
      { replace: true },
    );

  const count = (id: StatusFilter) =>
    id === status && remittances.data ? remittances.total : id === 'needs_review' ? needsReview.data : undefined;
  const tabs: TabItem<StatusFilter>[] = [
    { id: 'all', label: 'All', count: count('all') },
    ...STATUSES.map((id) => ({ id, label: REMITTANCE_STATUS_LABELS[id], count: count(id) })),
  ];
  const shown = remittances.items;

  return (
    <>
      <PageHeader
        title="Insurance payments"
        description="Remittances (ERAs) from payers, posted to claims and client balances."
        actions={
          <Button icon={<Upload className="h-4 w-4" />} onClick={() => setUploading(true)}>
            Upload ERA or acknowledgment
          </Button>
        }
      />
      <Card>
        <div className="px-4 pt-2 sm:px-5">
          <Tabs tabs={tabs} active={status} onChange={choose} />
        </div>
        {remittances.isPending && <SectionSpinner />}
        {remittances.isError && !remittances.data && <ErrorState error={remittances.error} onRetry={() => void remittances.refetch()} />}
        {remittances.data && shown.length === 0 && (
          <EmptyState
            icon={<Landmark />}
            title={status === 'all' ? 'No insurance payments yet' : `Nothing ${REMITTANCE_STATUS_LABELS[status].toLowerCase()}`}
            description={
              status === 'all'
                ? 'Payments arrive automatically through the clearinghouse, or upload an 835 file from your clearinghouse.'
                : undefined
            }
          />
        )}
        {shown.length > 0 && (
          <Table>
            <thead className="bg-sage-50/60">
              <tr>
                <Th>Payer</Th>
                <Th className="hidden sm:table-cell">Payment date</Th>
                <Th className="hidden md:table-cell">Check / EFT number</Th>
                <Th>Claims</Th>
                <Th className="text-right">Paid</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sage-100">
              {shown.map((remittance) => (
                <tr key={remittance.id} className="hover:bg-sage-50/60">
                  <Td>
                    <Link
                      to={`/portal/billing/remittances/${remittance.id}`}
                      className="font-medium text-primary-700 hover:underline"
                    >
                      {remittance.payer_name || 'Unknown payer'}
                    </Link>
                    <p className="text-xs text-sage-500">
                      {remittance.source === 'upload' ? 'Uploaded' : 'Received'} {formatDate(remittance.created_at, staff.time_zone)}
                    </p>
                  </Td>
                  <Td className="hidden whitespace-nowrap sm:table-cell">
                    {remittance.payment_date ? formatPlainDate(remittance.payment_date) : '—'}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <span className="font-mono text-xs">{remittance.trace_number}</span>
                    <span className="block text-xs text-sage-500">
                      {PAYMENT_METHOD_LABELS[remittance.payment_method] ?? remittance.payment_method}
                    </span>
                  </Td>
                  <Td>
                    {remittance.claim_count}
                    {remittance.unmatched_count > 0 && (
                      <span className="ml-2">
                        <Badge tone="warning">{remittance.unmatched_count} unmatched</Badge>
                      </span>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{formatMoney(remittance.total_paid_cents)}</Td>
                  <Td>
                    <RemittanceStatusBadge status={remittance.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <LoadMore noun="insurance payments" {...remittances.loadMore} />
      </Card>
      {uploading && <UploadResponseFileDialog onClose={() => setUploading(false)} />}
    </>
  );
}

/** Insurance payments: remittances by status, and uploading clearinghouse files. */
export default function RemittancesPage() {
  const billsEveryone = useCan('billing_all');
  useClaimsRealtime();
  return (
    <div>
      <BillingSubNav />
      {billsEveryone ? <RemittanceList /> : <RemittancesLocked />}
    </div>
  );
}
