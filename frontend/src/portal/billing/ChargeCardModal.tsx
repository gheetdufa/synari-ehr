import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  billingApi,
  cardExpiry,
  cardLabel,
  centsToInput,
  isCardExpired,
  validateAmount,
  MIN_CARD_CHARGE_CENTS,
  type SavedCard,
} from '../../api/billing';
import { ApiError } from '../../api/client';
import type { ClientRef } from '../../api/clients';
import { formatMoney, fullName } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Field, Select } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { MoneyInput } from './components/BillingDisplay';
import { CARD_CHARGE_RULES } from './helpers';
import { useInvalidateBilling, usePracticeDay } from './hooks';

/** Charge a client's saved card now, after an explicit confirmation. */
export function ChargeCardModal({
  client,
  cards,
  balanceCents,
  onClose,
}: {
  client: ClientRef;
  cards: SavedCard[];
  balanceCents: number;
  onClose: () => void;
}) {
  const formId = useId();
  const toast = useToast();
  const invalidate = useInvalidateBilling();
  const { today } = usePracticeDay();
  const defaultCard = cards.find((card) => card.is_default) ?? cards[0];
  const [cardId, setCardId] = useState<number>(defaultCard.id);
  const [amount, setAmount] = useState(balanceCents >= MIN_CARD_CHARGE_CENTS ? centsToInput(balanceCents) : '');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [confirmCents, setConfirmCents] = useState<number | null>(null);
  const card = cards.find((c) => c.id === cardId) ?? defaultCard;

  const charge = useMutation({
    mutationFn: (cents: number) => billingApi.charge(client.id, { amount_cents: cents, card_id: card.id }),
    onSuccess: async (payment) => {
      toast.success(
        payment.status === 'pending'
          ? `The ${formatMoney(payment.amount_cents)} charge to ${cardLabel(card)} is processing.`
          : `Charged ${formatMoney(payment.amount_cents)} to ${cardLabel(card)}.`,
      );
      await invalidate(client.id);
      onClose();
    },
    onError: async () => {
      // A declined charge is recorded as a failed payment; show it in the client's history.
      await invalidate(client.id);
      setConfirmCents(null);
    },
  });

  const review = (event: FormEvent) => {
    event.preventDefault();
    const result = validateAmount(amount, CARD_CHARGE_RULES);
    if (result.error !== null) {
      setAmountError(result.error);
      return;
    }
    setAmountError(null);
    charge.reset();
    setConfirmCents(result.cents);
  };

  const close = () => {
    if (!charge.isPending) onClose();
  };

  const declined = charge.error instanceof ApiError && charge.error.status === 402;
  const expired = isCardExpired(card, today);
  const extra = confirmCents !== null ? confirmCents - balanceCents : 0;

  return (
    <Modal
      open
      onClose={close}
      title="Charge card"
      description={`Charge ${fullName(client)}'s saved card now.`}
      size="sm"
      footer={
        confirmCents === null ? (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={formId}>
              Review charge
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setConfirmCents(null)} disabled={charge.isPending}>
              Back
            </Button>
            <Button loading={charge.isPending} onClick={() => !charge.isPending && charge.mutate(confirmCents)}>
              Charge {formatMoney(confirmCents)}
            </Button>
          </>
        )
      }
    >
      {confirmCents === null ? (
        <form id={formId} onSubmit={review} noValidate className="space-y-4">
          {charge.isError && (
            <Alert tone="danger" title={declined ? 'The card was declined' : "The charge didn't go through"}>
              {charge.error.message}
              {declined && ' Ask the client to update their card in the portal, or try another card.'}
            </Alert>
          )}
          <Field label="Card" required>
            {(props) => (
              <Select {...props} value={cardId} onChange={(event) => setCardId(Number(event.target.value))}>
                {cards.map((option) => (
                  <option key={option.id} value={option.id}>
                    {cardLabel(option)} · exp {cardExpiry(option)}
                    {option.is_default ? ' · default' : ''}
                    {isCardExpired(option, today) ? ' · expired' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {expired && <Alert tone="warning">This card has expired, so the charge will probably be declined.</Alert>}
          <Field
            label="Amount"
            required
            error={amountError}
            hint={`Balance due: ${formatMoney(balanceCents)}. Minimum card charge ${formatMoney(MIN_CARD_CHARGE_CENTS)}.`}
          >
            {(props) => <MoneyInput {...props} value={amount} onChange={(event) => setAmount(event.target.value)} />}
          </Field>
        </form>
      ) : (
        <div className="space-y-3">
          <Alert tone="warning" title={`Charge ${formatMoney(confirmCents)} to ${cardLabel(card)}?`}>
            The card is charged immediately and the payment is applied to {fullName(client)}'s oldest open invoices.
            {extra > 0 && ` ${formatMoney(extra)} is more than the balance and will be kept as credit.`}
          </Alert>
        </div>
      )}
    </Modal>
  );
}
