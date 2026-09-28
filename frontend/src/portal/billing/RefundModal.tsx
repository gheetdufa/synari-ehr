import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PAYMENT_METHOD_LABELS, billingApi, centsToInput, validateAmount, type Payment } from '../../api/billing';
import { formatDate, formatMoney, fullName } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Field } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { Detail, MoneyInput } from './components/BillingDisplay';
import { useInvalidateBilling, usePracticeDay } from './hooks';

/** Refund part or all of a payment, with a review step before any money moves. */
export function RefundModal({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const formId = useId();
  const toast = useToast();
  const invalidate = useInvalidateBilling();
  const { timeZone } = usePracticeDay();
  const [amount, setAmount] = useState(centsToInput(payment.refundable_cents));
  const [error, setError] = useState<string | null>(null);
  const [confirmCents, setConfirmCents] = useState<number | null>(null);
  const isCard = payment.method === 'card';

  const refund = useMutation({
    mutationFn: (cents: number) => billingApi.refund(payment.id, cents),
    onSuccess: async (updated, cents) => {
      toast.success(
        isCard
          ? `Refunded ${formatMoney(cents)} to the card. It usually appears on the statement in 5–10 business days.`
          : `Recorded a ${formatMoney(cents)} refund.`,
      );
      await invalidate(updated.client.id);
      onClose();
    },
  });

  const review = (event: FormEvent) => {
    event.preventDefault();
    const result = validateAmount(amount, {
      max: payment.refundable_cents,
      maxMessage: `You can refund up to ${formatMoney(payment.refundable_cents)}.`,
    });
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    setError(null);
    refund.reset();
    setConfirmCents(result.cents);
  };

  const close = () => {
    if (!refund.isPending) onClose();
  };

  const received = payment.received_at ?? payment.created_at;
  const reference = payment.reference ? ` · ${payment.reference}` : '';

  return (
    <Modal
      open
      onClose={close}
      title="Refund payment"
      size="sm"
      footer={
        confirmCents === null ? (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={formId}>
              Review refund
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setConfirmCents(null)} disabled={refund.isPending}>
              Back
            </Button>
            <Button variant="danger" loading={refund.isPending} onClick={() => !refund.isPending && refund.mutate(confirmCents)}>
              Refund {formatMoney(confirmCents)}
            </Button>
          </>
        )
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-3 rounded-lg bg-sage-50 p-3">
        <Detail label="Client">{fullName(payment.client)}</Detail>
        <Detail label="Received">{formatDate(received, timeZone)}</Detail>
        <Detail label="Method">
          {PAYMENT_METHOD_LABELS[payment.method]}
          {reference}
        </Detail>
        <Detail label="Refundable">
          <span className="tabular-nums">{formatMoney(payment.refundable_cents)}</span>
          {payment.refunded_cents > 0 && (
            <span className="block text-xs text-sage-500">{formatMoney(payment.refunded_cents)} already refunded</span>
          )}
        </Detail>
      </dl>

      {confirmCents === null ? (
        <form id={formId} onSubmit={review} noValidate className="space-y-3">
          <Field label="Refund amount" required error={error}>
            {(props) => <MoneyInput {...props} value={amount} onChange={(event) => setAmount(event.target.value)} />}
          </Field>
          <p className="text-xs text-sage-500">
            The refund comes out of this payment's unused credit first. If it was applied to invoices, the most recent ones
            reopen with a balance.
          </p>
        </form>
      ) : (
        <div className="space-y-3">
          {refund.isError && (
            <Alert tone="danger" title="The refund didn't go through">
              {refund.error.message}
            </Alert>
          )}
          <Alert tone="warning" title={`Refund ${formatMoney(confirmCents)} to ${fullName(payment.client)}?`}>
            {isCard
              ? `Stripe sends ${formatMoney(confirmCents)} back to the card the client paid with. This can't be undone.`
              : 'This records the refund in Synari. Return the money to the client yourself, for example by cash or check. This can’t be undone.'}
          </Alert>
        </div>
      )}
    </Modal>
  );
}
