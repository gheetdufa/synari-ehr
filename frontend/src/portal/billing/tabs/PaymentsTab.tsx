import { useState } from 'react';
import { Plus, Undo2, Wallet } from 'lucide-react';
import { PAYMENT_METHOD_LABELS, billingApi, billingKeys, type Payment } from '../../../api/billing';
import type { ClientRef } from '../../../api/clients';
import { formatDate, formatMoney, fullName } from '../../../lib/format';
import { usePagedQuery } from '../../../lib/paging';
import { usePublicConfig } from '../../../lib/usePublicConfig';
import { Button } from '../../../ui/Button';
import { EmptyState, ErrorState, Table, Td, Th } from '../../../ui/Display';
import { LoadMore } from '../../../ui/LoadMore';
import { SectionSpinner } from '../../../ui/Spinner';
import type { BillingDialog } from '../BillingDialogs';
import { ClientPicker } from '../components/ClientPicker';
import { PaymentStatusBadge } from '../components/BillingDisplay';
import { usePracticeDay } from '../hooks';

function RefundButton({
  payment,
  paymentsEnabled,
  openDialog,
}: {
  payment: Payment;
  paymentsEnabled: boolean;
  openDialog: (dialog: BillingDialog) => void;
}) {
  if (payment.refundable_cents <= 0) return null;
  const blocker = payment.method === 'card' && !paymentsEnabled ? 'Card refunds need Stripe to be configured' : null;
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<Undo2 className="h-4 w-4" />}
      disabled={blocker !== null}
      title={blocker ?? undefined}
      aria-label={`Refund payment from ${fullName(payment.client)}`}
      onClick={() => openDialog({ kind: 'refund', payment })}
    >
      Refund
    </Button>
  );
}

function MethodText({ payment }: { payment: Payment }) {
  return (
    <>
      {PAYMENT_METHOD_LABELS[payment.method]}
      {payment.reference && <span className="block text-xs text-sage-500">{payment.reference}</span>}
    </>
  );
}

/** Every payment with refunds and unapplied credit; record and refund from here. */
export function PaymentsTab({ openDialog }: { openDialog: (dialog: BillingDialog) => void }) {
  const { timeZone } = usePracticeDay();
  const { payments_enabled: paymentsEnabled } = usePublicConfig();
  const [client, setClient] = useState<ClientRef | null>(null);
  const params = { client_id: client?.id };
  const payments = usePagedQuery({
    queryKey: billingKeys.payments(params),
    fetchPage: (page) => billingApi.payments({ ...params, ...page }),
  });
  const list = payments.items;

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
        {payments.isSuccess && list.length > 0 && (
          <p className="pb-2 text-sm text-sage-600 sm:ml-auto">
            {payments.total.toLocaleString()} {payments.total === 1 ? 'payment' : 'payments'}
          </p>
        )}
      </div>

      {payments.isLoading && <SectionSpinner />}
      {payments.isError && !payments.data && <ErrorState error={payments.error} onRetry={() => payments.refetch()} />}
      {payments.isSuccess && list.length === 0 && (
        <EmptyState
          icon={<Wallet />}
          title={client === null ? 'No payments yet' : 'No payments from this client'}
          description="Card payments from the client portal show up here automatically. Record cash, checks and other payments yourself."
          action={
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => openDialog({ kind: 'recordPayment' })}>
              Record payment
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
                  <Th>Date</Th>
                  <Th>Client</Th>
                  <Th>Method</Th>
                  <Th className="text-right">Amount</Th>
                  <Th className="text-right">Refunded</Th>
                  <Th className="text-right">Unapplied</Th>
                  <Th>Status</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sage-100">
                {list.map((payment) => (
                  <tr key={payment.id}>
                    <Td className="whitespace-nowrap">{formatDate(payment.received_at ?? payment.created_at, timeZone)}</Td>
                    <Td>{fullName(payment.client)}</Td>
                    <Td>
                      <MethodText payment={payment} />
                    </Td>
                    <Td className="text-right font-medium tabular-nums">{formatMoney(payment.amount_cents)}</Td>
                    <Td className="text-right tabular-nums">{payment.refunded_cents > 0 ? formatMoney(payment.refunded_cents) : '—'}</Td>
                    <Td className="text-right tabular-nums">{payment.unapplied_cents > 0 ? formatMoney(payment.unapplied_cents) : '—'}</Td>
                    <Td>
                      <PaymentStatusBadge status={payment.status} />
                      {payment.status === 'failed' && payment.failure_reason && (
                        <span className="mt-1 block max-w-xs text-xs text-red-700">{payment.failure_reason}</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      <RefundButton payment={payment} paymentsEnabled={paymentsEnabled} openDialog={openDialog} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <ul className="divide-y divide-sage-100 md:hidden">
            {list.map((payment) => (
              <li key={payment.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sage-900">{fullName(payment.client)}</span>
                  <span className="font-semibold tabular-nums text-sage-900">{formatMoney(payment.amount_cents)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-sm text-sage-600">
                  <span>
                    {formatDate(payment.received_at ?? payment.created_at, timeZone)} · {PAYMENT_METHOD_LABELS[payment.method]}
                  </span>
                  <PaymentStatusBadge status={payment.status} />
                </div>
                {(payment.refunded_cents > 0 || payment.unapplied_cents > 0) && (
                  <p className="mt-1 text-xs text-sage-500">
                    {payment.refunded_cents > 0 && `${formatMoney(payment.refunded_cents)} refunded`}
                    {payment.refunded_cents > 0 && payment.unapplied_cents > 0 && ' · '}
                    {payment.unapplied_cents > 0 && `${formatMoney(payment.unapplied_cents)} unapplied credit`}
                  </p>
                )}
                {payment.status === 'failed' && payment.failure_reason && (
                  <p className="mt-1 text-xs text-red-700">{payment.failure_reason}</p>
                )}
                {payment.refundable_cents > 0 && (
                  <div className="mt-2">
                    <RefundButton payment={payment} paymentsEnabled={paymentsEnabled} openDialog={openDialog} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <LoadMore noun="payments" {...payments.loadMore} />
        </>
      )}
    </div>
  );
}
