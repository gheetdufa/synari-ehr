import { describe, expect, it } from 'vitest';
import { bannerFromParams, buildCheckoutPayload } from './helpers';

describe('bannerFromParams', () => {
  it.each([
    ['payment=success', 'success', 'Thanks — your payment is processing and will appear shortly'],
    ['payment=canceled', 'neutral', 'Payment canceled'],
    ['card=saved', 'success', 'Your card was saved'],
    ['card=canceled', 'neutral', 'No card was added'],
  ])('%s', (query, tone, title) => {
    expect(bannerFromParams(new URLSearchParams(query))).toMatchObject({ tone, title });
  });

  it('ignores other params', () => {
    expect(bannerFromParams(new URLSearchParams('payment=maybe&tab=x'))).toBeNull();
  });
});

describe('buildCheckoutPayload', () => {
  const balance = { kind: 'balance', balanceCents: 15000 } as const;

  it('pays the full balance without naming an amount', () => {
    expect(buildCheckoutPayload(balance, { mode: 'full', amount: '', saveCard: true })).toEqual({
      ok: true,
      amountCents: 15000,
      payload: { save_card: true },
    });
  });

  it('pays another amount up to the balance', () => {
    expect(buildCheckoutPayload(balance, { mode: 'other', amount: '40', saveCard: false })).toEqual({
      ok: true,
      amountCents: 4000,
      payload: { amount_cents: 4000, save_card: false },
    });
    expect(buildCheckoutPayload(balance, { mode: 'other', amount: '150.01', saveCard: false })).toEqual({
      ok: false,
      error: 'You can pay up to your balance of $150.00.',
    });
    expect(buildCheckoutPayload(balance, { mode: 'other', amount: '0.49', saveCard: false })).toEqual({
      ok: false,
      error: 'Online payments must be at least $0.50.',
    });
  });

  it('pays one invoice by id', () => {
    const invoice = { kind: 'invoice', invoiceId: 9, balanceCents: 7500 } as const;
    expect(buildCheckoutPayload(invoice, { mode: 'other', amount: '1', saveCard: true })).toEqual({
      ok: true,
      amountCents: 7500,
      payload: { invoice_id: 9, save_card: true },
    });
  });

  it('refuses balances under the card minimum', () => {
    expect(buildCheckoutPayload({ kind: 'balance', balanceCents: 30 }, { mode: 'full', amount: '', saveCard: false })).toEqual({
      ok: false,
      error: 'Online payments must be at least $0.50.',
    });
  });
});
