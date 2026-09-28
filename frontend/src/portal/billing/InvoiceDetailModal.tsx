import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Ban, Scale, Wallet } from 'lucide-react';
import { MAX_PAGE_SIZE } from '../../api/client';
import {
  PAYMENT_METHOD_LABELS,
  billingApi,
  billingKeys,
  type Invoice,
  type InvoiceItem,
  type InvoiceItemKind,
} from '../../api/billing';
import { formatDate, formatMoney, formatPlainDate, fullName } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert, Badge, ErrorState } from '../../ui/Display';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { Detail, InvoiceStatusBadge, PaymentStatusBadge, PdfButton } from './components/BillingDisplay';
import { useInvalidateBilling, usePracticeDay } from './hooks';

/** Labels for lines that aren't a session (session lines speak for themselves). */
const LINE_KIND_LABELS: Record<Exclude<InvoiceItemKind, 'service'>, string> = {
  adjustment: 'Insurance adjustment',
  custom: 'Other charge',
};

function LineDescription({ item }: { item: InvoiceItem }) {
  return (
    <>
      <span className="flex flex-wrap items-center gap-1.5">
        {item.description}
        {item.kind !== 'service' && (
          <Badge tone={item.kind === 'adjustment' ? 'info' : 'neutral'}>{LINE_KIND_LABELS[item.kind]}</Badge>
        )}
      </span>
      {(item.service_code || item.clinician_name) && (
        <span className="block text-xs text-sage-500 sm:hidden">
          {[item.service_code, item.clinician_name].filter(Boolean).join(' · ')}
        </span>
      )}
    </>
  );
}

/** An invoice's lines, payments applied and balance, with PDF, record payment and void. */
export function InvoiceDetailModal({
  invoiceId,
  onClose,
  onRecordPayment,
}: {
  invoiceId: number;
  onClose: () => void;
  onRecordPayment: (invoice: Invoice) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateBilling();
  const { today, timeZone } = usePracticeDay();
  const [confirmVoid, setConfirmVoid] = useState(false);

  const invoice = useQuery({ queryKey: billingKeys.invoice(invoiceId), queryFn: () => billingApi.invoice(invoiceId) });
  const payments = useQuery({
    queryKey: billingKeys.invoicePayments(invoiceId),
    queryFn: () => billingApi.payments({ invoice_id: invoiceId, limit: MAX_PAGE_SIZE }),
    select: (page) => page.items,
  });

  const voidInvoice = useMutation({
    mutationFn: () => billingApi.voidInvoice(invoiceId),
    onSuccess: async (updated) => {
      toast.success(`${updated.number} is void. Its sessions can be invoiced again.`);
      setConfirmVoid(false);
      await invalidate(updated.client.id);
    },
  });

  const dispute = useMutation({
    mutationFn: (disputed: boolean) => (disputed ? billingApi.disputeInvoice(invoiceId) : billingApi.resolveDispute(invoiceId)),
    onSuccess: async (updated) => {
      toast.success(
        updated.disputed_at
          ? `${updated.number} is marked disputed. AutoPay and automatic collection are paused for it.`
          : `The dispute over ${updated.number} is resolved.`,
      );
      await invalidate(updated.client.id);
    },
    onError: (error) => toast.error(error),
  });

  const close = () => {
    if (!voidInvoice.isPending && !dispute.isPending) onClose();
  };

  const data = invoice.data;
  const applied = (payments.data ?? []).flatMap((payment) =>
    payment.allocations
      .filter((allocation) => allocation.invoice_id === invoiceId)
      .map((allocation) => ({ payment, amount: allocation.amount_cents })),
  );
  const canVoid = data !== undefined && data.status !== 'void' && data.paid_cents === 0;

  const footer = data ? (
    confirmVoid ? (
      <>
        <Button variant="secondary" onClick={() => setConfirmVoid(false)} disabled={voidInvoice.isPending}>
          Keep invoice
        </Button>
        <Button variant="danger" loading={voidInvoice.isPending} onClick={() => !voidInvoice.isPending && voidInvoice.mutate()}>
          Void {data.number}
        </Button>
      </>
    ) : (
      <>
        <PdfButton download={() => billingApi.downloadInvoicePdf(data.id)} label="Download PDF" />
        {data.status !== 'void' && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Scale className="h-4 w-4" />}
            loading={dispute.isPending}
            onClick={() => !dispute.isPending && dispute.mutate(data.disputed_at === null)}
          >
            {data.disputed_at ? 'Resolve dispute' : 'Mark disputed'}
          </Button>
        )}
        {canVoid && (
          <Button variant="ghost" size="sm" icon={<Ban className="h-4 w-4" />} onClick={() => setConfirmVoid(true)}>
            Void
          </Button>
        )}
        {data.status === 'open' && (
          <Button size="sm" icon={<Wallet className="h-4 w-4" />} onClick={() => onRecordPayment(data)}>
            Record payment
          </Button>
        )}
      </>
    )
  ) : undefined;

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={
        data ? (
          <span className="flex flex-wrap items-center gap-2">
            {data.number} <InvoiceStatusBadge invoice={data} today={today} />
            {data.disputed_at && <Badge tone="warning">Disputed</Badge>}
          </span>
        ) : (
          'Invoice'
        )
      }
      description={data ? fullName(data.client) : undefined}
      footer={footer}
    >
      {invoice.isLoading && <SectionSpinner />}
      {invoice.isError && <ErrorState error={invoice.error} onRetry={() => invoice.refetch()} />}
      {data && (
        <div className="space-y-5">
          {confirmVoid && (
            <Alert tone="warning" title={`Void ${data.number}?`}>
              The client won't owe this {formatMoney(data.total_cents)} anymore and the invoice disappears from their portal.
              Its sessions move back to Uninvoiced so you can bill them again. This can't be undone.
              {voidInvoice.isError && <p className="mt-2 font-medium text-red-700">{voidInvoice.error.message}</p>}
            </Alert>
          )}
          {data.disputed_at && data.status !== 'void' && (
            <Alert tone="warning" title="The client disputes this bill">
              Marked disputed on {formatDate(data.disputed_at, timeZone)}. AutoPay and automatic collection are paused for
              this invoice until you resolve the dispute.
            </Alert>
          )}
          {data.status === 'void' && data.voided_at && (
            <Alert tone="neutral">Voided on {formatDate(data.voided_at, timeZone)}.</Alert>
          )}
          {data.status === 'open' && data.paid_cents > 0 && (
            <p className="text-sm text-sage-600">To void this invoice, refund its payments first.</p>
          )}

          {data.bill_to_name && (
            <dl>
              <Detail label="Bill to">
                {data.bill_to_name} <span className="text-sage-500">for {fullName(data.client)}</span>
              </Detail>
            </dl>
          )}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Detail label="Issued">{formatPlainDate(data.issued_on)}</Detail>
            <Detail label="Due">{formatPlainDate(data.due_on)}</Detail>
            <Detail label="Total">
              <span className="tabular-nums">{formatMoney(data.total_cents)}</span>
            </Detail>
            <Detail label="Balance">
              <span className="font-semibold tabular-nums">{formatMoney(data.balance_cents)}</span>
            </Detail>
          </dl>

          <section aria-label="Services">
            <h3 className="mb-2 text-sm font-semibold text-sage-900">Services</h3>
            <div className="overflow-hidden rounded-lg border border-sage-100">
              <table className="min-w-full divide-y divide-sage-100 text-sm">
                <thead className="bg-sage-50">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-sage-500">Date</th>
                    <th scope="col" className="hidden px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-sage-500 sm:table-cell">Code</th>
                    <th scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-sage-500">Description</th>
                    <th scope="col" className="hidden px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-sage-500 sm:table-cell">Clinician</th>
                    <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-sage-500">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-sage-100">
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <td className="whitespace-nowrap px-3 py-2 text-sage-800">{formatPlainDate(item.service_date)}</td>
                      <td className="hidden px-3 py-2 text-sage-600 sm:table-cell">{item.service_code || '—'}</td>
                      <td className="px-3 py-2 text-sage-800">
                        <LineDescription item={item} />
                      </td>
                      <td className="hidden px-3 py-2 text-sage-600 sm:table-cell">{item.clinician_name || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-sage-900">{formatMoney(item.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-sage-50/60 text-sm">
                  <tr>
                    <td colSpan={3} className="hidden sm:table-cell" />
                    <td className="px-3 py-1.5 text-right text-sage-600">Total</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sage-900">{formatMoney(data.total_cents)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="hidden sm:table-cell" />
                    <td className="px-3 py-1.5 text-right text-sage-600">Paid</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sage-900">
                      {data.paid_cents > 0 ? '−' : ''}
                      {formatMoney(data.paid_cents)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="hidden sm:table-cell" />
                    <td className="px-3 py-1.5 text-right font-semibold text-sage-900">Balance</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-sage-900">{formatMoney(data.balance_cents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section aria-label="Payments applied">
            <h3 className="mb-2 text-sm font-semibold text-sage-900">Payments applied</h3>
            {payments.isLoading && <p className="text-sm text-sage-500">Loading payments…</p>}
            {payments.isError && <p className="text-sm text-red-700">{payments.error.message}</p>}
            {payments.isSuccess && applied.length === 0 && <p className="text-sm text-sage-500">No payments applied yet.</p>}
            {applied.length > 0 && (
              <ul className="divide-y divide-sage-100 rounded-lg border border-sage-100">
                {applied.map(({ payment, amount }) => (
                  <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="text-sage-900">{formatDate(payment.received_at ?? payment.created_at, timeZone)}</span>
                      <span className="text-sage-500">
                        {' · '}
                        {PAYMENT_METHOD_LABELS[payment.method]}
                        {payment.reference && ` · ${payment.reference}`}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <PaymentStatusBadge status={payment.status} />
                      <span className="font-medium tabular-nums text-sage-900">{formatMoney(amount)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.notes && (
            <section aria-label="Notes">
              <h3 className="mb-1 text-sm font-semibold text-sage-900">Notes</h3>
              <p className="whitespace-pre-wrap text-sm text-sage-700">{data.notes}</p>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
