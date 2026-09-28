import { useState } from 'react';
import { FileCheck2, Plus } from 'lucide-react';
import { billingApi, billingKeys, type Superbill } from '../../../api/billing';
import type { ClientRef } from '../../../api/clients';
import { formatDate, formatMoney, formatPlainDate } from '../../../lib/format';
import { usePagedQuery } from '../../../lib/paging';
import { Button } from '../../../ui/Button';
import { EmptyState, ErrorState, Table, Td, Th } from '../../../ui/Display';
import { LoadMore } from '../../../ui/LoadMore';
import { SectionSpinner } from '../../../ui/Spinner';
import type { BillingDialog } from '../BillingDialogs';
import { ClientPicker } from '../components/ClientPicker';
import { PdfButton } from '../components/BillingDisplay';
import { usePracticeDay } from '../hooks';

/** Who provided the services: one clinician, or several (each line names its own). */
function providerSummary(superbill: Superbill): string {
  return superbill.data.provider?.name ?? 'Several clinicians';
}

/** Generated superbills: open one for its details, or download its PDF. */
export function SuperbillsTab({ openDialog }: { openDialog: (dialog: BillingDialog) => void }) {
  const { timeZone } = usePracticeDay();
  const view = (superbill: Superbill) => openDialog({ kind: 'viewSuperbill', superbill });
  const [client, setClient] = useState<ClientRef | null>(null);
  const params = { client_id: client?.id };
  const superbills = usePagedQuery({
    queryKey: billingKeys.superbills(params),
    fetchPage: (page) => billingApi.superbills({ ...params, ...page }),
  });
  const list = superbills.items;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 border-b border-sage-100 px-4 py-3 sm:px-5">
        <ClientPicker
          label="Client"
          placeholder="All clients"
          clearLabel="Show all clients"
          value={client}
          onChange={setClient}
          className="w-full sm:w-64"
        />
        {superbills.isSuccess && list.length > 0 && (
          <p className="pb-2 text-sm text-sage-600 sm:ml-auto">
            {superbills.total.toLocaleString()} {superbills.total === 1 ? 'superbill' : 'superbills'}
          </p>
        )}
      </div>

      {superbills.isLoading && <SectionSpinner />}
      {superbills.isError && !superbills.data && <ErrorState error={superbills.error} onRetry={() => superbills.refetch()} />}
      {superbills.isSuccess && list.length === 0 && (
        <EmptyState
          icon={<FileCheck2 />}
          title={client === null ? 'No superbills yet' : 'No superbills for this client'}
          description="Superbills let clients with out-of-network benefits ask their insurer for reimbursement."
          action={
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => openDialog({ kind: 'superbill' })}>
              Generate superbill
            </Button>
          }
        />
      )}

      {list.length > 0 && (
        <>
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Superbill</Th>
                  <Th>Client</Th>
                  <Th>Provider</Th>
                  <Th>Period</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="text-right">Paid</Th>
                  <Th>Created</Th>
                  <Th>
                    <span className="sr-only">Download</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sage-100">
                {list.map((superbill) => (
                  <tr key={superbill.id}>
                    <Td>
                      <button
                        type="button"
                        onClick={() => view(superbill)}
                        className="font-medium text-primary-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                      >
                        {superbill.number}
                      </button>
                    </Td>
                    <Td>{superbill.data.client.name}</Td>
                    <Td>{providerSummary(superbill)}</Td>
                    <Td className="whitespace-nowrap">
                      {formatPlainDate(superbill.period_start)} – {formatPlainDate(superbill.period_end)}
                    </Td>
                    <Td className="text-right tabular-nums">{formatMoney(superbill.total_cents)}</Td>
                    <Td className="text-right tabular-nums">{formatMoney(superbill.paid_cents)}</Td>
                    <Td className="whitespace-nowrap">{formatDate(superbill.created_at, timeZone)}</Td>
                    <Td className="text-right">
                      <PdfButton
                        download={() => billingApi.downloadSuperbillPdf(superbill.id)}
                        accessibleLabel={`Download ${superbill.number} as PDF`}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <ul className="divide-y divide-sage-100 md:hidden">
            {list.map((superbill) => (
              <li key={superbill.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <button type="button" onClick={() => view(superbill)} className="min-w-0 text-left">
                  <span className="block font-medium text-sage-900">{superbill.data.client.name}</span>
                  <span className="block text-sm text-sage-600">
                    {superbill.number} · {formatPlainDate(superbill.period_start)} – {formatPlainDate(superbill.period_end)}
                  </span>
                  <span className="block text-sm text-sage-600">{providerSummary(superbill)}</span>
                  <span className="block text-sm tabular-nums text-sage-900">{formatMoney(superbill.total_cents)}</span>
                </button>
                <PdfButton
                  download={() => billingApi.downloadSuperbillPdf(superbill.id)}
                  accessibleLabel={`Download ${superbill.number} as PDF`}
                />
              </li>
            ))}
          </ul>
          <LoadMore noun="superbills" {...superbills.loadMore} />
        </>
      )}
    </div>
  );
}
