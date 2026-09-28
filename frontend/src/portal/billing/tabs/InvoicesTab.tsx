import { useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { billingApi, billingKeys, type InvoiceStatus } from '../../../api/billing';
import type { ClientRef } from '../../../api/clients';
import { formatMoney, formatPlainDate, fullName } from '../../../lib/format';
import { usePagedQuery } from '../../../lib/paging';
import { Button } from '../../../ui/Button';
import { Badge, EmptyState, ErrorState, Table, Td, Th } from '../../../ui/Display';
import { Field, Select } from '../../../ui/Form';
import { LoadMore } from '../../../ui/LoadMore';
import { SectionSpinner } from '../../../ui/Spinner';
import type { BillingDialog } from '../BillingDialogs';
import { ClientPicker } from '../components/ClientPicker';
import { InvoiceStatusBadge } from '../components/BillingDisplay';
import { usePracticeDay } from '../hooks';

export type InvoiceFilter = InvoiceStatus | 'all';

const FILTERS: { id: InvoiceFilter; label: string }[] = [
  { id: 'all', label: 'All statuses' },
  { id: 'open', label: 'Open' },
  { id: 'paid', label: 'Paid' },
  { id: 'void', label: 'Void' },
];

/** All invoices, filterable by status and client; rows open the invoice. */
export function InvoicesTab({
  status,
  onStatusChange,
  openDialog,
}: {
  status: InvoiceFilter;
  onStatusChange: (status: InvoiceFilter) => void;
  openDialog: (dialog: BillingDialog) => void;
}) {
  const { today } = usePracticeDay();
  const [client, setClient] = useState<ClientRef | null>(null);
  const params = { client_id: client?.id, status: status === 'all' ? undefined : status };
  const invoices = usePagedQuery({
    queryKey: billingKeys.invoices(params),
    fetchPage: (page) => billingApi.invoices({ ...params, ...page }),
  });
  const list = invoices.items;
  const open = (invoiceId: number) => openDialog({ kind: 'invoice', invoiceId });

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 border-b border-sage-100 px-4 py-3 sm:px-5">
        <Field label="Status" className="w-full sm:w-44">
          {(props) => (
            <Select {...props} value={status} onChange={(event) => onStatusChange(event.target.value as InvoiceFilter)}>
              {FILTERS.map((filter) => (
                <option key={filter.id} value={filter.id}>
                  {filter.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ClientPicker
          label="Client"
          placeholder="All clients"
          clearLabel="Show all clients"
          value={client}
          onChange={setClient}
          className="w-full sm:w-64"
        />
        {invoices.isSuccess && list.length > 0 && (
          <p className="pb-2 text-sm text-sage-600 sm:ml-auto">
            {invoices.total.toLocaleString()} {invoices.total === 1 ? 'invoice' : 'invoices'}
          </p>
        )}
      </div>

      {invoices.isLoading && <SectionSpinner />}
      {invoices.isError && !invoices.data && <ErrorState error={invoices.error} onRetry={() => invoices.refetch()} />}
      {invoices.isSuccess && list.length === 0 && (
        <EmptyState
          icon={<FileText />}
          title={status === 'all' && client === null ? 'No invoices yet' : 'No invoices match these filters'}
          description="Invoices are created each night for past sessions, or you can create one now."
          action={
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => openDialog({ kind: 'newInvoice', initialClient: client ?? undefined })}>
              New invoice
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
                  <Th>Invoice</Th>
                  <Th>Client</Th>
                  <Th>Issued</Th>
                  <Th>Due</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="text-right">Paid</Th>
                  <Th className="text-right">Balance</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sage-100">
                {list.map((invoice) => (
                  <tr key={invoice.id} onClick={() => open(invoice.id)} className="cursor-pointer hover:bg-sage-50">
                    <Td>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          open(invoice.id);
                        }}
                        className="font-medium text-primary-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                      >
                        {invoice.number}
                      </button>
                    </Td>
                    <Td>
                      {fullName(invoice.client)}
                      {invoice.bill_to_name && <span className="block text-xs text-sage-500">Bill to {invoice.bill_to_name}</span>}
                    </Td>
                    <Td className="whitespace-nowrap">{formatPlainDate(invoice.issued_on)}</Td>
                    <Td className="whitespace-nowrap">{formatPlainDate(invoice.due_on)}</Td>
                    <Td className="text-right tabular-nums">{formatMoney(invoice.total_cents)}</Td>
                    <Td className="text-right tabular-nums">{formatMoney(invoice.paid_cents)}</Td>
                    <Td className="text-right font-medium tabular-nums">{formatMoney(invoice.balance_cents)}</Td>
                    <Td>
                      <span className="inline-flex flex-wrap items-center gap-1">
                        <InvoiceStatusBadge invoice={invoice} today={today} />
                        {invoice.disputed_at && <Badge tone="warning">Disputed</Badge>}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <ul className="divide-y divide-sage-100 md:hidden">
            {list.map((invoice) => (
              <li key={invoice.id}>
                <button type="button" onClick={() => open(invoice.id)} className="block w-full px-4 py-3 text-left hover:bg-sage-50">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sage-900">{fullName(invoice.client)}</span>
                    <span className="inline-flex items-center gap-1">
                      <InvoiceStatusBadge invoice={invoice} today={today} />
                      {invoice.disputed_at && <Badge tone="warning">Disputed</Badge>}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2 text-sm text-sage-600">
                    <span>
                      {invoice.number} · due {formatPlainDate(invoice.due_on)}
                    </span>
                    <span className="tabular-nums">
                      <span className="font-medium text-sage-900">{formatMoney(invoice.balance_cents)}</span>
                      {invoice.balance_cents !== invoice.total_cents && ` of ${formatMoney(invoice.total_cents)}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <LoadMore noun="invoices" {...invoices.loadMore} />
        </>
      )}
    </div>
  );
}
