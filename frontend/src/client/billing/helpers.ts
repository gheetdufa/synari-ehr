import { MIN_CARD_CHARGE_CENTS, validateAmount, type CheckoutCreate } from '../../api/billing';
import { formatMoney } from '../../lib/format';

/** A notice shown after Stripe sends the client back to the billing page. */
export interface ReturnBanner {
  tone: 'success' | 'neutral';
  title: string;
  message: string;
}

/** The banner for Stripe's return query (?payment=success|canceled or ?card=saved|canceled). */
export function bannerFromParams(params: URLSearchParams): ReturnBanner | null {
  const payment = params.get('payment');
  const card = params.get('card');
  if (payment === 'success') {
    return {
      tone: 'success',
      title: 'Thanks — your payment is processing and will appear shortly',
      message: "We'll email you a receipt once it goes through.",
    };
  }
  if (payment === 'canceled') {
    return { tone: 'neutral', title: 'Payment canceled', message: "You weren't charged. You can pay whenever you're ready." };
  }
  if (card === 'saved') {
    return { tone: 'success', title: 'Your card was saved', message: 'It will appear below in a moment.' };
  }
  if (card === 'canceled') {
    return { tone: 'neutral', title: 'No card was added', message: 'You can add a card at any time.' };
  }
  return null;
}

/** The query keys Stripe adds when it returns the client. */
export const RETURN_PARAMS = ['payment', 'card'] as const;

export type PayTarget = { kind: 'balance'; balanceCents: number } | { kind: 'invoice'; invoiceId: number; balanceCents: number };

export type CheckoutResult = { ok: true; payload: CheckoutCreate; amountCents: number } | { ok: false; error: string };

/**
 * Validate what the client chose to pay and build the checkout body: one invoice, the full
 * balance (no amount, so the server charges whatever is owed), or another amount up to the balance.
 */
export function buildCheckoutPayload(
  target: PayTarget,
  choice: { mode: 'full' | 'other'; amount: string; saveCard: boolean },
): CheckoutResult {
  const minMessage = `Online payments must be at least ${formatMoney(MIN_CARD_CHARGE_CENTS)}.`;
  if (target.kind === 'invoice') {
    if (target.balanceCents < MIN_CARD_CHARGE_CENTS) return { ok: false, error: minMessage };
    return {
      ok: true,
      amountCents: target.balanceCents,
      payload: { invoice_id: target.invoiceId, save_card: choice.saveCard },
    };
  }
  if (choice.mode === 'full') {
    if (target.balanceCents < MIN_CARD_CHARGE_CENTS) return { ok: false, error: minMessage };
    return { ok: true, amountCents: target.balanceCents, payload: { save_card: choice.saveCard } };
  }
  const amount = validateAmount(choice.amount, {
    min: MIN_CARD_CHARGE_CENTS,
    minMessage,
    max: target.balanceCents,
    maxMessage: `You can pay up to your balance of ${formatMoney(target.balanceCents)}.`,
  });
  if (amount.error !== null) return { ok: false, error: amount.error };
  return { ok: true, amountCents: amount.cents, payload: { amount_cents: amount.cents, save_card: choice.saveCard } };
}
