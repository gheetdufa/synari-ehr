import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { billingApi, type ClientBillingSummary, type Invoice, type Payment } from '../../api/billing';
import { clientsApi, type ClientRef } from '../../api/clients';
import { page } from '../../test/page';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { RecordPaymentModal } from './RecordPaymentModal';

const client: ClientRef = { id: 3, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' };

function invoice(changes: Partial<Invoice>): Invoice {
  return {
    id: 7,
    client,
    number: 'INV-000007',
    issued_on: '2026-09-01',
    due_on: '2026-09-15',
    status: 'open',
    total_cents: 15000,
    paid_cents: 3000,
    balance_cents: 12000,
    notes: '',
    bill_to_contact_id: null,
    bill_to_name: '',
    voided_at: null,
    disputed_at: null,
    gfe_override_reason: '',
    created_at: '2026-09-01T12:00:00Z',
    items: [],
    ...changes,
  };
}

const openInvoices = [invoice({}), invoice({ id: 8, number: 'INV-000008', paid_cents: 0, balance_cents: 9000, total_cents: 9000 })];

const billingSummary: ClientBillingSummary = {
  client_id: 3,
  balance_cents: 21000,
  credit_cents: 0,
  open_invoices: openInvoices,
  recent_payments: [],
  saved_cards: [],
  autopay_enabled: false,
  autopay_failures: 0,
  payments_enabled: false,
};

function payment(amountCents: number): Payment {
  return {
    id: 50,
    client,
    amount_cents: amountCents,
    method: 'cash',
    status: 'succeeded',
    refunded_cents: 0,
    refundable_cents: amountCents,
    unapplied_cents: 0,
    reference: '',
    failure_reason: '',
    received_at: '2026-09-25T15:00:00Z',
    created_at: '2026-09-25T15:00:00Z',
    allocations: [],
  };
}

function renderModal(props: Partial<Parameters<typeof RecordPaymentModal>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WithSession session={testSession()}>
        <ToastProvider>{children}</ToastProvider>
      </WithSession>
    </QueryClientProvider>
  );
  render(<RecordPaymentModal onClose={onClose} {...props} />, { wrapper });
  return { onClose };
}

describe('RecordPaymentModal', () => {
  beforeEach(() => {
    vi.spyOn(billingApi, 'clientSummary').mockResolvedValue(billingSummary);
    vi.spyOn(clientsApi, 'list').mockResolvedValue(page([]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefills the chosen invoice balance and records the payment against it', async () => {
    const user = userEvent.setup();
    const record = vi.spyOn(billingApi, 'recordPayment').mockResolvedValue(payment(12000));
    const { onClose } = renderModal({ fixedClient: client, initialInvoiceId: 7 });

    expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
    const amount = await screen.findByLabelText(/Amount/);
    await waitFor(() => expect(amount).toHaveValue('120.00'));
    expect(screen.getByText('Client balance: $210.00')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Method/), 'check');
    await user.type(screen.getByLabelText('Reference'), '1042');
    await user.click(screen.getByRole('button', { name: 'Record $120.00' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual({
      client_id: 3,
      amount_cents: 12000,
      method: 'check',
      reference: '1042',
      send_receipt: true,
      invoice_id: 7,
    });
    expect(await screen.findByText('Recorded a $120.00 payment from Alex Rivera.')).toBeInTheDocument();
  });

  it('suggests the full balance when applying to the oldest invoices and explains extra credit', async () => {
    const user = userEvent.setup();
    const record = vi.spyOn(billingApi, 'recordPayment').mockResolvedValue(payment(25000));
    renderModal({ fixedClient: client });

    const amount = await screen.findByLabelText(/Amount/);
    await waitFor(() => expect(amount).toHaveValue('210.00'));
    await user.clear(amount);
    await user.type(amount, '250');
    expect(screen.getByText(/\$40\.00 more than the client owes/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Record $250.00' }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).not.toHaveProperty('invoice_id');
    expect(record.mock.calls[0][0]).toMatchObject({ amount_cents: 25000, method: 'cash' });
  });

  it('validates the amount and client before calling the API', async () => {
    const user = userEvent.setup();
    const record = vi.spyOn(billingApi, 'recordPayment');
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText('Choose a client.')).toBeInTheDocument();
    expect(screen.getByText('Enter an amount.')).toBeInTheDocument();
    expect(record).not.toHaveBeenCalled();
  });

  it('submits once while pending and shows server errors', async () => {
    const user = userEvent.setup();
    let reject: (error: Error) => void = () => undefined;
    const record = vi.spyOn(billingApi, 'recordPayment').mockReturnValue(
      new Promise<Payment>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const { onClose } = renderModal({ fixedClient: client, initialInvoiceId: 7 });
    const submit = await screen.findByRole('button', { name: 'Record $120.00' });

    await user.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());
    await user.click(submit);
    expect(record).toHaveBeenCalledTimes(1);

    reject(new ApiError(422, 'That invoice belongs to another client'));
    expect(await screen.findByText('That invoice belongs to another client')).toBeInTheDocument();
    expect(submit).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
