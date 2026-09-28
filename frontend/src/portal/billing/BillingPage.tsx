import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, FilePlus2, FileText, Landmark, Receipt, Wallet } from 'lucide-react';
import { billingApi, billingKeys, type InvoiceStatus } from '../../api/billing';
import { estimateKeys, estimatesApi } from '../../api/estimates';
import { formatMoney } from '../../lib/format';
import { usePublicConfig } from '../../lib/usePublicConfig';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { PageHeader, Tabs, type TabItem } from '../../ui/Display';
import { BillingSubNav } from '../insurance/BillingSubNav';
import { BillingDialogs, type BillingDialog } from './BillingDialogs';
import { StatCard } from './components/BillingDisplay';
import { StripeSetupNotice } from './components/StripeSetupNotice';
import { useBillingRealtime, useBillingScope } from './hooks';
import { InvoicesTab, type InvoiceFilter } from './tabs/InvoicesTab';
import { PaymentsTab } from './tabs/PaymentsTab';
import { SuperbillsTab } from './tabs/SuperbillsTab';
import { EstimatesNeededTab } from './tabs/EstimatesNeededTab';
import { UninvoicedTab } from './tabs/UninvoicedTab';

type TabId = 'invoices' | 'payments' | 'superbills' | 'uninvoiced' | 'estimates';

const TAB_LABELS: Record<TabId, string> = {
  invoices: 'Invoices',
  payments: 'Payments',
  superbills: 'Superbills',
  uninvoiced: 'Uninvoiced',
  estimates: 'Estimates needed',
};
const TAB_IDS = Object.keys(TAB_LABELS) as TabId[];
const INVOICE_STATUSES: InvoiceStatus[] = ['open', 'paid', 'void'];

function parseTab(value: string | null): TabId {
  return TAB_IDS.find((id) => id === value) ?? 'invoices';
}

function parseStatus(value: string | null): InvoiceFilter {
  return INVOICE_STATUSES.find((status) => status === value) ?? 'all';
}

/**
 * Billing: totals, invoices, payments, superbills and sessions waiting to be invoiced, for the
 * whole practice (`billing_all`) or the signed-in clinician's own clients (`billing_own`).
 */
export default function BillingPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const status = parseStatus(params.get('status'));
  const [dialog, setDialog] = useState<BillingDialog | null>(null);
  const { payments_enabled: paymentsEnabled } = usePublicConfig();
  const own = useBillingScope() === 'own';
  useBillingRealtime();

  const overview = useQuery({ queryKey: billingKeys.overview, queryFn: billingApi.overview });
  const estimatesNeeded = useQuery({ queryKey: estimateKeys.needed, queryFn: estimatesApi.needed });

  const navigate = (nextTab: TabId, nextStatus?: InvoiceFilter) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('tab', nextTab);
        const statusValue = nextStatus ?? (nextTab === 'invoices' ? parseStatus(current.get('status')) : 'all');
        if (nextTab === 'invoices' && statusValue !== 'all') next.set('status', statusValue);
        else next.delete('status');
        return next;
      },
      { replace: true },
    );

  const data = overview.data;
  const stat = (value: (overviewData: NonNullable<typeof data>) => string) =>
    data ? value(data) : overview.isError ? '—' : '…';

  const tabs: TabItem<TabId>[] = TAB_IDS.map((id) => ({
    id,
    label: TAB_LABELS[id],
    count: id === 'uninvoiced' ? data?.uninvoiced_count : id === 'estimates' ? estimatesNeeded.data?.length : undefined,
  }));

  return (
    <div>
      <BillingSubNav />
      <PageHeader
        title="Billing"
        description={
          own
            ? 'Invoices, payments and superbills for your clients. Other clients are billed by your practice.'
            : 'Invoices, payments and superbills for your practice.'
        }
        actions={
          <>
            <Button variant="secondary" icon={<FileText className="h-4 w-4" />} onClick={() => setDialog({ kind: 'superbill' })}>
              Generate superbill
            </Button>
            <Button variant="secondary" icon={<Wallet className="h-4 w-4" />} onClick={() => setDialog({ kind: 'recordPayment' })}>
              Record payment
            </Button>
            <Button icon={<FilePlus2 className="h-4 w-4" />} onClick={() => setDialog({ kind: 'newInvoice' })}>
              New invoice
            </Button>
          </>
        }
      />

      <section aria-label="Billing overview" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Outstanding"
          icon={<Landmark />}
          value={stat((d) => formatMoney(d.outstanding_cents))}
          hint={own ? "Owed on your clients' open invoices" : 'Owed on open invoices'}
          onClick={() => navigate('invoices', 'open')}
        />
        <StatCard
          label="Collected this month"
          icon={<Receipt />}
          value={stat((d) => formatMoney(d.collected_this_month_cents))}
          hint="Payments received, less refunds"
          onClick={() => navigate('payments')}
        />
        <StatCard
          label="Open invoices"
          icon={<FileText />}
          value={stat((d) => String(d.open_invoice_count))}
          hint="Waiting for payment"
          onClick={() => navigate('invoices', 'open')}
        />
        <StatCard
          label="Uninvoiced"
          icon={<CalendarClock />}
          value={stat((d) => String(d.uninvoiced_count))}
          hint={own ? "Your clients' past sessions to bill" : 'Past sessions to bill'}
          tone={data && data.uninvoiced_count > 0 ? 'attention' : 'default'}
          onClick={() => navigate('uninvoiced')}
        />
      </section>
      {overview.isError && (
        <p role="alert" className="-mt-3 mb-4 text-sm text-red-700">
          Couldn't load billing totals: {overview.error.message}
        </p>
      )}

      {tab === 'payments' && !paymentsEnabled && (
        <div className="mb-4">
          <StripeSetupNotice />
        </div>
      )}

      <Card>
        <div className="px-4 pt-2 sm:px-5">
          <Tabs tabs={tabs} active={tab} onChange={(id) => navigate(id)} />
        </div>
        <div role="tabpanel" aria-label={TAB_LABELS[tab]}>
          {tab === 'invoices' && (
            <InvoicesTab status={status} onStatusChange={(next) => navigate('invoices', next)} openDialog={setDialog} />
          )}
          {tab === 'payments' && <PaymentsTab openDialog={setDialog} />}
          {tab === 'superbills' && <SuperbillsTab openDialog={setDialog} />}
          {tab === 'uninvoiced' && <UninvoicedTab openDialog={setDialog} />}
          {tab === 'estimates' && <EstimatesNeededTab />}
        </div>
      </Card>

      <BillingDialogs dialog={dialog} onChange={setDialog} />
    </div>
  );
}
