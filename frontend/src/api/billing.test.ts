import { describe, expect, it } from 'vitest';
import {
  INVOICE_STATUS_LABELS,
  MAX_AMOUNT_CENTS,
  MIN_CARD_CHARGE_CENTS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  cardExpiry,
  cardLabel,
  centsToInput,
  invoiceDisplayStatus,
  isCardExpired,
  todayInZone,
  validateAmount,
} from './billing';

describe('validateAmount', () => {
  it.each([
    ['45', 4500],
    ['45.5', 4550],
    ['45.50', 4550],
    ['$1,200.00', 120000],
    [' 0.29 ', 29],
    ['0.01', 1],
    ['100000', MAX_AMOUNT_CENTS],
  ])('parses %j as %i cents', (input, cents) => {
    expect(validateAmount(input)).toEqual({ cents, error: null });
  });

  it.each([
    ['', 'Enter an amount.'],
    ['   ', 'Enter an amount.'],
    ['abc', 'Enter a dollar amount, like 45 or 45.50.'],
    ['45.555', 'Enter a dollar amount, like 45 or 45.50.'],
    ['-5', 'Enter a dollar amount, like 45 or 45.50.'],
    ['1e3', 'Enter a dollar amount, like 45 or 45.50.'],
    ['0', 'Enter an amount greater than $0.00.'],
    ['0.00', 'Enter an amount greater than $0.00.'],
    ['100000.01', 'Amounts can be at most $100,000.00.'],
  ])('rejects %j', (input, error) => {
    expect(validateAmount(input)).toEqual({ cents: null, error });
  });

  it('enforces a minimum with a custom message', () => {
    const rules = { min: MIN_CARD_CHARGE_CENTS, minMessage: 'Too small.' };
    expect(validateAmount('0.49', rules)).toEqual({ cents: null, error: 'Too small.' });
    expect(validateAmount('0.50', rules)).toEqual({ cents: 50, error: null });
  });

  it('enforces a maximum such as the balance', () => {
    expect(validateAmount('120.01', { max: 12000 })).toEqual({ cents: null, error: 'The most you can enter is $120.00.' });
    expect(validateAmount('120', { max: 12000 })).toEqual({ cents: 12000, error: null });
    expect(validateAmount('121', { max: 12000, maxMessage: 'Over balance.' })).toEqual({ cents: null, error: 'Over balance.' });
  });
});

describe('centsToInput', () => {
  it('formats cents for an input field', () => {
    expect(centsToInput(4550)).toBe('45.50');
    expect(centsToInput(5)).toBe('0.05');
    expect(validateAmount(centsToInput(123456)).cents).toBe(123456);
  });
});

describe('invoiceDisplayStatus', () => {
  const today = '2026-09-25';
  it.each([
    [{ status: 'open', due_on: '2026-10-01', paid_cents: 0 }, 'open'],
    [{ status: 'open', due_on: '2026-09-25', paid_cents: 0 }, 'open'],
    [{ status: 'open', due_on: '2026-10-01', paid_cents: 500 }, 'partial'],
    [{ status: 'open', due_on: '2026-09-24', paid_cents: 0 }, 'overdue'],
    [{ status: 'open', due_on: '2026-09-24', paid_cents: 500 }, 'overdue'],
    [{ status: 'paid', due_on: '2026-09-01', paid_cents: 15000 }, 'paid'],
    [{ status: 'void', due_on: '2026-09-01', paid_cents: 0 }, 'void'],
  ] as const)('%j is %s', (invoice, expected) => {
    expect(invoiceDisplayStatus(invoice, today)).toBe(expected);
  });

  it('has a label for every display status', () => {
    expect(INVOICE_STATUS_LABELS.overdue).toBe('Overdue');
    expect(INVOICE_STATUS_LABELS.partial).toBe('Partly paid');
  });
});

describe('labels', () => {
  it('names payment methods and statuses', () => {
    expect(PAYMENT_METHOD_LABELS.external_card).toBe('Card (external)');
    expect(PAYMENT_METHOD_LABELS.card).toBe('Card (online)');
    expect(PAYMENT_STATUS_LABELS.pending).toBe('Processing');
    expect(PAYMENT_STATUS_LABELS.partially_refunded).toBe('Partly refunded');
  });
});

describe('cards', () => {
  const card = { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2028 };

  it('describes a card', () => {
    expect(cardLabel(card)).toBe('Visa •••• 4242');
    expect(cardLabel({ brand: 'amex', last4: '0005' })).toBe('American Express •••• 0005');
    expect(cardLabel({ brand: 'link', last4: '' })).toBe('Link');
    expect(cardExpiry(card)).toBe('04/28');
  });

  it('treats a card as valid through its expiry month', () => {
    expect(isCardExpired(card, '2028-04-30')).toBe(false);
    expect(isCardExpired(card, '2028-05-01')).toBe(true);
    expect(isCardExpired(card, '2029-01-01')).toBe(true);
    expect(isCardExpired({ exp_month: 0, exp_year: 0 }, '2030-01-01')).toBe(false);
  });
});

describe('todayInZone', () => {
  it('uses the calendar date in the given zone', () => {
    const instant = new Date('2026-09-25T02:30:00Z');
    expect(todayInZone('America/Los_Angeles', instant)).toBe('2026-09-24');
    expect(todayInZone('Asia/Tokyo', instant)).toBe('2026-09-25');
  });
});
