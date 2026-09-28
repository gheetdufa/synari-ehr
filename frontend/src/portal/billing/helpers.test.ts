import { describe, expect, it } from 'vitest';
import {
  buildInvoicePayload,
  buildPaymentPayload,
  lastMonthRange,
  receivedAtIso,
  superbillPeriodError,
  type InvoiceDraft,
  type ManualLineDraft,
  type PaymentDraft,
} from './helpers';

const amounts = new Map([
  [11, 15000],
  [12, 7500],
]);

function line(changes: Partial<ManualLineDraft> = {}): ManualLineDraft {
  return { key: 'a', service_date: '2026-09-20', description: 'Records request', service_code: '', amount: '25', ...changes };
}

function invoiceDraft(changes: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return { clientId: 3, participantIds: [], lines: [], notes: '', notify: true, ...changes };
}

describe('buildInvoicePayload', () => {
  it('builds a payload from selected sessions by participant', () => {
    const result = buildInvoicePayload(invoiceDraft({ participantIds: [11, 12] }), amounts);
    expect(result).toEqual({
      ok: true,
      totalCents: 22500,
      payload: { client_id: 3, participant_ids: [11, 12], items: [], notes: '', notify: true },
    });
  });

  it('combines sessions with trimmed custom lines and totals them', () => {
    const result = buildInvoicePayload(
      invoiceDraft({
        participantIds: [11, 11],
        lines: [line({ description: '  Letter  ', service_code: ' 90889 ', amount: '$40.50' })],
        notes: '  Thanks!  ',
        notify: false,
      }),
      amounts,
    );
    expect(result).toEqual({
      ok: true,
      totalCents: 19050,
      payload: {
        client_id: 3,
        participant_ids: [11],
        items: [{ service_date: '2026-09-20', description: 'Letter', service_code: '90889', amount_cents: 4050 }],
        notes: 'Thanks!',
        notify: false,
      },
    });
  });

  it('needs a client', () => {
    const result = buildInvoicePayload(invoiceDraft({ clientId: null, participantIds: [11] }), amounts);
    expect(result).toEqual({ ok: false, formError: 'Choose a client.', lineErrors: {} });
  });

  it('needs at least one session or line', () => {
    const result = buildInvoicePayload(invoiceDraft(), amounts);
    expect(result).toEqual({ ok: false, formError: 'Select at least one session or add a line.', lineErrors: {} });
  });

  it('reports errors per custom line', () => {
    const result = buildInvoicePayload(
      invoiceDraft({
        lines: [
          line({ key: 'ok' }),
          line({ key: 'bad', description: ' ', amount: '0', service_date: '', service_code: 'X'.repeat(21) }),
        ],
      }),
      amounts,
    );
    expect(result).toEqual({
      ok: false,
      formError: null,
      lineErrors: {
        bad: {
          description: 'Add a description.',
          amount: 'Enter an amount greater than $0.00.',
          service_date: 'Pick a date.',
          service_code: 'Codes are at most 20 characters.',
        },
      },
    });
  });
});

function paymentDraft(changes: Partial<PaymentDraft> = {}): PaymentDraft {
  return {
    clientId: 3,
    amount: '120',
    method: 'check',
    reference: ' #1042 ',
    receivedOn: '2026-09-25',
    invoiceId: null,
    sendReceipt: true,
    ...changes,
  };
}

describe('buildPaymentPayload', () => {
  const today = '2026-09-25';
  const zone = 'America/New_York';

  it('omits received_at for today and invoice_id when applying oldest first', () => {
    expect(buildPaymentPayload(paymentDraft(), today, zone)).toEqual({
      ok: true,
      payload: { client_id: 3, amount_cents: 12000, method: 'check', reference: '#1042', send_receipt: true },
    });
  });

  it('applies to the chosen invoice and dates earlier payments at noon locally', () => {
    const result = buildPaymentPayload(paymentDraft({ invoiceId: 7, receivedOn: '2026-09-20', sendReceipt: false }), today, zone);
    expect(result).toEqual({
      ok: true,
      payload: {
        client_id: 3,
        amount_cents: 12000,
        method: 'check',
        reference: '#1042',
        send_receipt: false,
        invoice_id: 7,
        received_at: '2026-09-20T16:00:00.000Z',
      },
    });
  });

  it('validates every field', () => {
    const result = buildPaymentPayload(
      paymentDraft({ clientId: null, amount: 'ten', reference: 'x'.repeat(201), receivedOn: '2026-09-26' }),
      today,
      zone,
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        client: 'Choose a client.',
        amount: 'Enter a dollar amount, like 45 or 45.50.',
        reference: 'Keep the reference under 200 characters.',
        receivedOn: "The date can't be in the future.",
      },
    });
  });
});

describe('dates', () => {
  it('converts a past local date to noon in the practice zone', () => {
    expect(receivedAtIso('2026-01-15', '2026-09-25', 'America/Los_Angeles')).toBe('2026-01-15T20:00:00.000Z');
    expect(receivedAtIso('2026-09-25', '2026-09-25', 'America/Los_Angeles')).toBeUndefined();
  });

  it.each([
    ['2026-09-25', { start: '2026-08-01', end: '2026-08-31' }],
    ['2026-03-01', { start: '2026-02-01', end: '2026-02-28' }],
    ['2028-03-10', { start: '2028-02-01', end: '2028-02-29' }],
    ['2026-01-05', { start: '2025-12-01', end: '2025-12-31' }],
  ])('last month before %s', (today, range) => {
    expect(lastMonthRange(today)).toEqual(range);
  });

  it('checks superbill periods', () => {
    expect(superbillPeriodError('2026-08-01', '2026-08-31')).toBeNull();
    expect(superbillPeriodError('2026-08-01', '2026-08-01')).toBeNull();
    expect(superbillPeriodError('2026-08-31', '2026-08-01')).toBe('The period must end on or after its start.');
    expect(superbillPeriodError('2025-01-01', '2026-01-03')).toBe('A superbill can cover at most one year.');
    expect(superbillPeriodError('', '2026-01-03')).toBe('Pick a start and end date.');
  });
});
