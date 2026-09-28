import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  MANUAL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  billingApi,
  billingKeys,
  centsToInput,
  validateAmount,
  type ManualPaymentMethod,
  type Payment,
} from '../../api/billing';
import type { ClientRef } from '../../api/clients';
import { formatMoney, formatPlainDate, fullName } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox, Field, Input, Select } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { ClientPicker } from './components/ClientPicker';
import { MoneyInput } from './components/BillingDisplay';
import { buildPaymentPayload, type PaymentErrors } from './helpers';
import { useInvalidateBilling, usePracticeDay } from './hooks';

const REFERENCE_HINTS: Record<ManualPaymentMethod, string> = {
  cash: 'Optional note',
  check: 'Check number',
  external_card: 'Receipt or transaction number',
  other: 'For example Zelle or HSA card',
};

/** Record money received outside Synari (cash, check, a card run elsewhere). */
export function RecordPaymentModal({
  fixedClient,
  initialInvoiceId,
  onClose,
  onRecorded,
}: {
  fixedClient?: ClientRef;
  initialInvoiceId?: number;
  onClose: () => void;
  onRecorded?: (payment: Payment) => void;
}) {
  const formId = useId();
  const toast = useToast();
  const invalidate = useInvalidateBilling();
  const { today, timeZone } = usePracticeDay();

  const [client, setClient] = useState<ClientRef | null>(fixedClient ?? null);
  const clientId = client?.id ?? null;
  const [invoiceId, setInvoiceId] = useState<number | null>(initialInvoiceId ?? null);
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [method, setMethod] = useState<ManualPaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(today);
  const [sendReceipt, setSendReceipt] = useState(true);
  const [errors, setErrors] = useState<PaymentErrors>({});

  // The client's summary lists every open invoice and the balance they add up to.
  const openInvoices = useQuery({
    queryKey: billingKeys.clientSummary(clientId ?? 0),
    queryFn: () => billingApi.clientSummary(clientId!),
    enabled: clientId !== null,
  });
  const invoices = openInvoices.data?.open_invoices ?? [];
  const balance = openInvoices.data?.balance_cents ?? 0;
  const selectedInvoice = invoices.find((invoice) => invoice.id === invoiceId) ?? null;
  const suggested = selectedInvoice?.balance_cents ?? balance;
  const amountValue = amountTouched ? amount : suggested > 0 ? centsToInput(suggested) : '';
  const parsed = validateAmount(amountValue);
  const credit = parsed.cents !== null && clientId !== null && openInvoices.isSuccess ? parsed.cents - balance : 0;

  const record = useMutation({
    mutationFn: billingApi.recordPayment,
    onSuccess: async (payment) => {
      toast.success(`Recorded a ${formatMoney(payment.amount_cents)} payment from ${fullName(payment.client)}.`);
      await invalidate(payment.client.id);
      onRecorded?.(payment);
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (record.isPending) return;
    const result = buildPaymentPayload(
      { clientId, amount: amountValue, method, reference, receivedOn, invoiceId: selectedInvoice?.id ?? null, sendReceipt },
      today,
      timeZone,
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    record.mutate(result.payload);
  };

  const close = () => {
    if (!record.isPending) onClose();
  };

  return (
    <Modal
      open
      onClose={close}
      title="Record payment"
      description="For money received outside Synari, like cash, a check or a card run on another terminal."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={record.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={record.isPending}>
            {parsed.cents !== null ? `Record ${formatMoney(parsed.cents)}` : 'Record payment'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {record.isError && (
          <Alert tone="danger" title="The payment wasn't recorded">
            {record.error.message}
          </Alert>
        )}
        <ClientPicker
          fixed={fixedClient}
          value={client}
          onChange={(next) => {
            setClient(next);
            setInvoiceId(null);
          }}
          error={errors.client}
          required
        />

        {clientId !== null && (
          <Field
            label="Apply to"
            hint="The payment goes to this invoice first, then the oldest open invoices. Anything left over is kept as credit."
          >
            {(props) => (
              <Select
                {...props}
                value={invoiceId ?? ''}
                disabled={openInvoices.isLoading}
                onChange={(event) => setInvoiceId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">
                  {openInvoices.isLoading
                    ? 'Loading invoices…'
                    : invoices.length === 0
                      ? 'No open invoices (kept as credit)'
                      : 'Oldest open invoices first'}
                </option>
                {invoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.number} · {formatPlainDate(invoice.issued_on)} · {formatMoney(invoice.balance_cents)} due
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Amount"
            required
            error={errors.amount}
            hint={clientId !== null && openInvoices.isSuccess ? `Client balance: ${formatMoney(balance)}` : undefined}
          >
            {(props) => (
              <MoneyInput
                {...props}
                value={amountValue}
                onChange={(event) => {
                  setAmountTouched(true);
                  setAmount(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Date received" required error={errors.receivedOn}>
            {(props) => (
              <Input {...props} type="date" max={today} value={receivedOn} onChange={(event) => setReceivedOn(event.target.value)} />
            )}
          </Field>
          <Field label="Method" required>
            {(props) => (
              <Select {...props} value={method} onChange={(event) => setMethod(event.target.value as ManualPaymentMethod)}>
                {MANUAL_PAYMENT_METHODS.map((option) => (
                  <option key={option} value={option}>
                    {PAYMENT_METHOD_LABELS[option]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reference" error={errors.reference}>
            {(props) => (
              <Input
                {...props}
                value={reference}
                maxLength={200}
                placeholder={REFERENCE_HINTS[method]}
                onChange={(event) => setReference(event.target.value)}
              />
            )}
          </Field>
        </div>

        {credit > 0 && (
          <Alert tone="info">
            {balance > 0
              ? `This is ${formatMoney(credit)} more than the client owes. The extra is kept as credit for future invoices.`
              : `The client has no open balance, so ${formatMoney(credit)} will be kept as credit for future invoices.`}
          </Alert>
        )}

        <Checkbox
          label="Email the client a receipt"
          description="Sent when the client has portal billing turned on."
          checked={sendReceipt}
          onChange={(event) => setSendReceipt(event.target.checked)}
        />
      </form>
    </Modal>
  );
}
