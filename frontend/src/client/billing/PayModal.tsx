import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { portalBillingApi, validateAmount } from '../../api/billing';
import { formatMoney } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox, Field } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { MoneyInput } from '../../portal/billing/components/BillingDisplay';
import { buildCheckoutPayload, type PayTarget } from './helpers';

/** Choose what to pay, then continue to Stripe's secure checkout page. */
export function PayModal({
  target,
  invoiceNumber,
  hasSavedCard,
  onClose,
}: {
  target: PayTarget;
  invoiceNumber?: string;
  hasSavedCard: boolean;
  onClose: () => void;
}) {
  const formId = useId();
  const [mode, setMode] = useState<'full' | 'other'>('full');
  const [amount, setAmount] = useState('');
  const [saveCard, setSaveCard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  const checkout = useMutation({
    mutationFn: portalBillingApi.checkout,
    onSuccess: ({ url }) => {
      setRedirecting(true);
      window.location.assign(url);
    },
  });
  const busy = checkout.isPending || redirecting;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const result = buildCheckoutPayload(target, { mode, amount, saveCard });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    checkout.mutate(result.payload);
  };

  const otherCents = mode === 'other' ? validateAmount(amount).cents : null;
  const payCents = mode === 'full' || target.kind === 'invoice' ? target.balanceCents : otherCents;

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={target.kind === 'invoice' ? `Pay ${invoiceNumber ?? 'invoice'}` : 'Pay balance'}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy} icon={<Lock className="h-4 w-4" />}>
            {payCents ? `Continue to pay ${formatMoney(payCents)}` : 'Continue to payment'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {checkout.isError && (
          <Alert tone="danger" title="We couldn't start the payment">
            {checkout.error.message}
          </Alert>
        )}

        {target.kind === 'invoice' ? (
          <p className="text-sm text-sage-700">
            Amount due: <span className="font-semibold tabular-nums text-sage-900">{formatMoney(target.balanceCents)}</span>
          </p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-sage-800">How much would you like to pay?</legend>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-sage-200 px-3 py-2.5 has-[:checked]:border-primary-400 has-[:checked]:bg-primary-50">
              <input
                type="radio"
                name={`${formId}-mode`}
                checked={mode === 'full'}
                onChange={() => setMode('full')}
                className="h-4 w-4 border-sage-300 text-primary-600 focus:ring-primary-400"
              />
              <span className="flex-1 text-sm text-sage-800">Full balance</span>
              <span className="text-sm font-semibold tabular-nums text-sage-900">{formatMoney(target.balanceCents)}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-sage-200 px-3 py-2.5 has-[:checked]:border-primary-400 has-[:checked]:bg-primary-50">
              <input
                type="radio"
                name={`${formId}-mode`}
                checked={mode === 'other'}
                onChange={() => setMode('other')}
                className="h-4 w-4 border-sage-300 text-primary-600 focus:ring-primary-400"
              />
              <span className="flex-1 text-sm text-sage-800">Another amount</span>
            </label>
            {mode === 'other' && (
              <Field
                label="Amount"
                error={error}
                hint={`Up to ${formatMoney(target.balanceCents)}. Partial payments go to your oldest invoices first.`}
              >
                {(props) => <MoneyInput {...props} autoFocus value={amount} onChange={(event) => setAmount(event.target.value)} />}
              </Field>
            )}
          </fieldset>
        )}
        {error && (mode === 'full' || target.kind === 'invoice') && <Alert tone="danger">{error}</Alert>}

        <Checkbox
          label="Save card for future payments"
          description={
            hasSavedCard
              ? 'Adds this card to your saved cards.'
              : 'Your practice can then charge it for future sessions, including AutoPay if they set it up with you.'
          }
          checked={saveCard}
          onChange={(event) => setSaveCard(event.target.checked)}
        />
        <p className="flex items-start gap-2 text-xs text-sage-500">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          You'll enter your card on Stripe's secure page. Your card number is never stored by this portal.
        </p>
      </form>
    </Modal>
  );
}
