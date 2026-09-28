import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '../../api/auth';
import {
  billingApi,
  type BillingOverview,
  type Invoice,
  type Superbill,
  type SuperbillProvider,
  type UninvoicedSession,
} from '../../api/billing';
import { ApiError } from '../../api/client';
import { clientsApi, type ClientRef, type ClientSummary } from '../../api/clients';
import { estimatesApi, type EstimateNeed } from '../../api/estimates';
import { page } from '../../test/page';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import BillingPage from './BillingPage';
import ClientBillingTab from './ClientBillingTab';
import { InvoiceDetailModal } from './InvoiceDetailModal';
import { NewInvoiceModal } from './NewInvoiceModal';
import { SuperbillDetailModal } from './SuperbillDetailModal';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const alex: ClientRef = { id: 3, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' };
const sam: ClientRef = { id: 4, first_name: 'Sam', last_name: 'Park', preferred_name: '' };

const ownBilling = testSession({
  staff: { id: 1, role: 'clinician', clinician_access: 'billing' },
  capabilities: ['billing_own'],
});

function session(changes: Partial<UninvoicedSession>): UninvoicedSession {
  return {
    participant_id: 21,
    appointment_id: 11,
    client: alex,
    clinician_id: 1,
    clinician_name: 'Dana Lee, LCSW',
    starts_at: '2026-09-22T14:00:00Z',
    ends_at: '2026-09-22T14:50:00Z',
    service_code: '90834',
    service_description: 'Psychotherapy, 45 min',
    status: 'attended',
    amount_cents: 2500,
    estimate_warning: '',
    ...changes,
  };
}

const UNINVOICED = [
  session({}),
  session({
    participant_id: 22,
    appointment_id: 12,
    clinician_id: 2,
    clinician_name: 'Jordan Kim, LPC',
    starts_at: '2026-09-23T15:00:00Z',
    status: 'no_show',
    amount_cents: 15000,
  }),
  session({
    participant_id: 30,
    appointment_id: 13,
    client: sam,
    amount_cents: 12000,
    estimate_warning: 'No good faith estimate covers this self-pay session',
  }),
];

const OVERVIEW: BillingOverview = {
  outstanding_cents: 45000,
  collected_this_month_cents: 90000,
  open_invoice_count: 3,
  uninvoiced_count: 3,
};

function invoice(changes: Partial<Invoice> = {}): Invoice {
  return {
    id: 70,
    client: alex,
    number: 'INV-000070',
    issued_on: '2026-09-26',
    due_on: '2026-10-10',
    status: 'open',
    total_cents: 2000,
    paid_cents: 0,
    balance_cents: 2000,
    notes: '',
    bill_to_contact_id: 5,
    bill_to_name: 'Maria Rivera',
    voided_at: null,
    disputed_at: null,
    gfe_override_reason: '',
    created_at: '2026-09-26T12:00:00Z',
    items: [
      {
        id: 1,
        kind: 'service',
        participant_id: 21,
        appointment_id: 11,
        service_date: '2026-09-22',
        service_code: '90834',
        description: 'Psychotherapy, 45 min',
        amount_cents: 2500,
        clinician_id: 1,
        clinician_name: 'Dana Lee, LCSW',
      },
      {
        id: 2,
        kind: 'adjustment',
        participant_id: 21,
        appointment_id: 11,
        service_date: '2026-09-22',
        service_code: '90834',
        description: 'Insurer paid more than expected',
        amount_cents: -500,
        clinician_id: 1,
        clinician_name: 'Dana Lee, LCSW',
      },
    ],
    ...changes,
  };
}

function summary(client: ClientRef, careTeam: number[]): ClientSummary {
  return {
    ...client,
    status: 'active',
    email: null,
    phone: '',
    date_of_birth: null,
    created_at: '2026-01-01T00:00:00Z',
    care_team: careTeam.map((staffId, index) => ({ staff_id: staffId, name: `Clinician ${staffId}`, is_primary: index === 0 })),
  };
}

function renderWith(ui: ReactNode, signedIn: Session = testSession(), path = '/portal/billing') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={signedIn}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
            {ui}
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('BillingPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    vi.spyOn(billingApi, 'overview').mockResolvedValue(OVERVIEW);
    vi.spyOn(billingApi, 'invoices').mockResolvedValue(page([]));
    vi.spyOn(billingApi, 'payments').mockResolvedValue(page([]));
    vi.spyOn(billingApi, 'uninvoiced').mockImplementation((params = {}) =>
      Promise.resolve(page(UNINVOICED.filter((row) => params.client_id === undefined || row.client.id === params.client_id))),
    );
    vi.spyOn(clientsApi, 'list').mockResolvedValue(page([summary(alex, [1, 2]), summary(sam, [2])]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['practice-wide billing', testSession(), 'Invoices, payments and superbills for your practice.', 'Past sessions to bill'],
    [
      'billing for their own clients',
      ownBilling,
      'Invoices, payments and superbills for your clients. Other clients are billed by your practice.',
      "Your clients' past sessions to bill",
    ],
  ])('describes the scope of %s', async (_who, signedIn, description, uninvoicedHint) => {
    renderWith(<BillingPage />, signedIn);
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(screen.getByText(uninvoicedHint)).toBeInTheDocument();
    expect(await screen.findByText('$450.00')).toBeInTheDocument();
  });

  it('lists uninvoiced sessions per client with their clinicians and invoices the chosen participants', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(billingApi, 'createInvoice').mockResolvedValue(invoice());
    vi.spyOn(billingApi, 'invoice').mockResolvedValue(invoice());
    renderWith(<BillingPage />, testSession(), '/portal/billing?tab=uninvoiced');

    const alexSessions = await screen.findByRole('table', { name: 'Uninvoiced sessions for Alex Rivera' });
    const rows = within(alexSessions).getAllByRole('row');
    expect(within(rows[0]).getByRole('columnheader', { name: 'Clinician' })).toBeInTheDocument();
    expect(within(rows[1]).getByText('Dana Lee, LCSW')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Jordan Kim, LPC')).toBeInTheDocument();
    expect(within(rows[2]).getByText('No show')).toBeInTheDocument();
    expect(screen.getByText('2 sessions ·')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create invoice for Alex Rivera' }));
    const dialog = await screen.findByRole('dialog', { name: 'New invoice' });
    const dana = await within(dialog).findByRole('checkbox', { name: /Dana Lee, LCSW/ });
    const jordan = within(dialog).getByRole('checkbox', { name: /Jordan Kim, LPC/ });
    expect(dana).toBeChecked();
    expect(jordan).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Create invoice for $175.00' })).toBeInTheDocument();

    await user.click(jordan);
    await user.click(within(dialog).getByRole('button', { name: 'Create invoice for $25.00' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toEqual({ client_id: 3, participant_ids: [21], items: [], notes: '', notify: true });

    const detail = await screen.findByRole('dialog', { name: /INV-000070/ });
    expect(within(detail).getByText('Maria Rivera')).toBeInTheDocument();
    expect(within(detail).getByText('Insurance adjustment')).toBeInTheDocument();
    expect(within(detail).getAllByText('Dana Lee, LCSW').length).toBeGreaterThan(0);
    expect(within(detail).getByText('-$5.00')).toBeInTheDocument();
    expect(billingApi.payments).toHaveBeenCalledWith({ invoice_id: 70, limit: 200 });
  });
});

describe('BillingPage estimates', () => {
  const NEEDS: EstimateNeed[] = [
    {
      client: alex,
      clinician_id: 1,
      clinician_name: 'Dana Lee, LCSW',
      reason: 'scheduling',
      due_on: '2026-09-25',
      overdue: true,
      estimate_id: 12,
      uncovered_sessions: 8,
      next_session_at: '2026-10-01T14:00:00Z',
    },
    {
      client: sam,
      clinician_id: 2,
      clinician_name: 'Jordan Kim, LPC',
      reason: 'request',
      due_on: '2026-10-01',
      overdue: false,
      estimate_id: null,
      uncovered_sessions: 0,
      next_session_at: null,
    },
  ];

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    vi.spyOn(billingApi, 'overview').mockResolvedValue(OVERVIEW);
    vi.spyOn(billingApi, 'uninvoiced').mockResolvedValue(page(UNINVOICED));
    vi.spyOn(estimatesApi, 'needed').mockResolvedValue(NEEDS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists who needs a good faith estimate, overdue ones highlighted, linking to their charts', async () => {
    renderWith(<BillingPage />, testSession(), '/portal/billing?tab=estimates');
    expect(await screen.findByRole('tab', { name: /Estimates needed/ })).toHaveAttribute('aria-selected', 'true');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getByText('Alex Rivera')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Overdue')).toBeInTheDocument();
    expect(within(rows[1]).getByText('8 sessions not covered')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link', { name: 'Open draft for Alex Rivera' })).toHaveAttribute(
      'href',
      '/portal/clients/3?tab=estimates',
    );
    expect(within(rows[2]).getByText('Client asked for one')).toBeInTheDocument();
    expect(within(rows[2]).queryByText('Overdue')).not.toBeInTheDocument();
    expect(within(rows[2]).getByRole('link', { name: 'Start estimate for Sam Park' })).toBeInTheDocument();
    expect(screen.getByText('1 is overdue.')).toBeInTheDocument();
  });

  it.each([
    [[session({})], /^1 past session that isn't on an invoice yet\./],
    [UNINVOICED, /^3 past sessions that aren't on an invoice yet\./],
  ])('counts uninvoiced sessions in plain English (%#)', async (rows, sentence) => {
    vi.spyOn(billingApi, 'uninvoiced').mockResolvedValue(page(rows));
    renderWith(<BillingPage />, testSession(), '/portal/billing?tab=uninvoiced');
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it('flags uninvoiced self-pay sessions without a covering estimate', async () => {
    renderWith(<BillingPage />, testSession(), '/portal/billing?tab=uninvoiced');
    const samSessions = await screen.findByRole('table', { name: 'Uninvoiced sessions for Sam Park' });
    expect(within(samSessions).getByText('No good faith estimate covers this self-pay session')).toBeInTheDocument();
  });
});

describe('NewInvoiceModal estimate checks', () => {
  beforeEach(() => {
    vi.spyOn(clientsApi, 'list').mockResolvedValue(page([summary(alex, [1, 2])]));
    vi.spyOn(billingApi, 'uninvoiced').mockResolvedValue(page([session({})]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for a reason before billing $400 or more over the estimate', async () => {
    const user = userEvent.setup();
    const check = vi.spyOn(billingApi, 'estimateCheck').mockResolvedValue({
      warnings: ['Charges for Dana Lee, LCSW would be $2,250.00 against an estimate of $1,800.00.'],
      override_required: true,
      over_by_cents: 45000,
    });
    const create = vi.spyOn(billingApi, 'createInvoice').mockResolvedValue(invoice());
    renderWith(<NewInvoiceModal fixedClient={alex} initialParticipantIds={[21]} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New invoice' });
    await within(dialog).findByRole('checkbox', { name: /Dana Lee, LCSW/ });
    await user.click(within(dialog).getByRole('button', { name: 'Create invoice for $25.00' }));
    expect(await within(dialog).findByText('This invoice would bill $450.00 more than the good faith estimate')).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith({ client_id: 3, participant_ids: [21], items: [], notes: '', notify: true });
    expect(create).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Create invoice with override' }));
    expect(within(dialog).getByText('Explain why this invoice goes over the good faith estimate.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole('textbox', { name: /Reason for going over the estimate/ }), 'Client added sessions');
    await user.click(within(dialog).getByRole('button', { name: 'Create invoice with override' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toEqual({
      client_id: 3,
      participant_ids: [21],
      items: [],
      notes: '',
      notify: true,
      gfe_override_reason: 'Client added sessions',
    });
  });

  it('shows warnings once, then creates the invoice when confirmed', async () => {
    const user = userEvent.setup();
    vi.spyOn(billingApi, 'estimateCheck').mockResolvedValue({
      warnings: ['This self-pay client has no good faith estimate for Dana Lee, LCSW.'],
      override_required: false,
      over_by_cents: 0,
    });
    const create = vi.spyOn(billingApi, 'createInvoice').mockResolvedValue(invoice());
    renderWith(<NewInvoiceModal fixedClient={alex} initialParticipantIds={[21]} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New invoice' });
    await within(dialog).findByRole('checkbox', { name: /Dana Lee, LCSW/ });
    await user.click(within(dialog).getByRole('button', { name: 'Create invoice for $25.00' }));
    expect(await within(dialog).findByText('This self-pay client has no good faith estimate for Dana Lee, LCSW.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Create invoice anyway' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).not.toHaveProperty('gfe_override_reason');
  });

  it('asks for the reason when the server says an override is needed', async () => {
    const user = userEvent.setup();
    vi.spyOn(billingApi, 'estimateCheck').mockRejectedValue(new ApiError(0, null));
    const create = vi
      .spyOn(billingApi, 'createInvoice')
      .mockRejectedValueOnce(
        new ApiError(409, {
          code: 'estimate_override_required',
          message: 'Charges would be $450.00 over the good faith estimate.',
          over_by_cents: 45000,
        }),
      )
      .mockResolvedValue(invoice());
    renderWith(<NewInvoiceModal fixedClient={alex} initialParticipantIds={[21]} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New invoice' });
    await within(dialog).findByRole('checkbox', { name: /Dana Lee, LCSW/ });
    await user.click(within(dialog).getByRole('button', { name: 'Create invoice for $25.00' }));
    expect(await within(dialog).findByText('Charges would be $450.00 over the good faith estimate.')).toBeInTheDocument();
    expect(within(dialog).queryByText("The invoice wasn't created")).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason for going over the estimate/ }), 'Agreed with client');
    await user.click(within(dialog).getByRole('button', { name: 'Create invoice with override' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0]).toMatchObject({ gfe_override_reason: 'Agreed with client' });
  });
});

describe('InvoiceDetailModal disputes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks an invoice disputed, which pauses AutoPay, and resolves it', async () => {
    const user = userEvent.setup();
    vi.spyOn(billingApi, 'payments').mockResolvedValue(page([]));
    const disputed = invoice({ disputed_at: '2026-09-26T15:00:00Z' });
    vi.spyOn(billingApi, 'invoice').mockResolvedValueOnce(invoice()).mockResolvedValue(disputed);
    const dispute = vi.spyOn(billingApi, 'disputeInvoice').mockResolvedValue(disputed);
    const resolve = vi.spyOn(billingApi, 'resolveDispute').mockResolvedValue(invoice());
    renderWith(<InvoiceDetailModal invoiceId={70} onClose={vi.fn()} onRecordPayment={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Mark disputed' }));
    await waitFor(() => expect(dispute).toHaveBeenCalledWith(70));
    const dialog = await screen.findByRole('dialog', { name: /INV-000070/ });
    expect(await within(dialog).findByText('Disputed')).toBeInTheDocument();
    expect(within(dialog).getByText(/AutoPay and automatic collection are paused/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Resolve dispute' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(70));
  });
});

describe('NewInvoiceModal', () => {
  beforeEach(() => {
    vi.spyOn(clientsApi, 'list').mockResolvedValue(page([summary(alex, [1, 2])]));
    vi.spyOn(billingApi, 'uninvoiced').mockResolvedValue(page([session({})]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('searches the clients whose billing the signed-in person sees, then loads their sessions', async () => {
    const user = userEvent.setup();
    renderWith(<NewInvoiceModal onClose={vi.fn()} />, ownBilling);
    const search = await screen.findByRole('combobox', { name: /Client/ });
    await user.type(search, 'riv');
    await user.click(await screen.findByRole('option', { name: /Alex Rivera/ }));

    expect(clientsApi.list).toHaveBeenLastCalledWith({ q: 'riv', access: 'billing', limit: 8 });
    expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
    await waitFor(() => expect(billingApi.uninvoiced).toHaveBeenCalledWith({ client_id: 3, limit: 500 }));
    expect(await screen.findByRole('checkbox', { name: /Dana Lee, LCSW/ })).toBeInTheDocument();
  });
});

describe('ClientBillingTab', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explains when a client's billing is outside the viewer's role", async () => {
    vi.spyOn(billingApi, 'clientSummary').mockRejectedValue(new ApiError(404, 'Client not found'));
    vi.spyOn(clientsApi, 'get').mockRejectedValue(new ApiError(404, 'Client not found'));
    renderWith(<ClientBillingTab clientId={3} />, ownBilling);
    expect(await screen.findByText("Billing isn't available to your role")).toBeInTheDocument();
  });
});

describe('SuperbillDetailModal', () => {
  const dana: SuperbillProvider = {
    name: 'Dana Lee',
    credentials: 'LCSW',
    npi: '1234567893',
    taxonomy_code: '1041C0700X',
    license: 'LC123 (NY)',
  };
  const jordan: SuperbillProvider = { name: 'Jordan Kim', credentials: 'LPC', npi: '', taxonomy_code: '', license: '' };

  function superbill(provider: SuperbillProvider | null): Superbill {
    return {
      id: 5,
      client_id: 3,
      number: 'SB-000005',
      period_start: '2026-08-01',
      period_end: '2026-08-31',
      total_cents: 30000,
      paid_cents: 15000,
      created_at: '2026-09-01T12:00:00Z',
      data: {
        practice: {
          name: 'Lee Counseling',
          address_lines: ['1 Main St', 'Albany, NY 12207'],
          phone: '555-0100',
          tax_id: '12-3456789',
          tax_id_type: 'EIN',
          npi: '1928374650',
          taxonomy_code: '193200000X',
          billing_provider: 'organization',
        },
        provider,
        client: { name: 'Alex Rivera', date_of_birth: '2012-03-04', address_lines: [], phone: '' },
        insurance: {
          payer_name: 'Aetna',
          payer_id: '60054',
          member_id: 'W123',
          group_number: 'G9',
          plan_name: 'Choice POS II',
          subscriber_name: 'Maria Rivera',
          subscriber_relationship: 'Child',
          subscriber_dob: '1980-05-06',
        },
        diagnosis_codes: [{ code: 'F41.1', description: 'Generalized anxiety disorder' }],
        lines: [
          { date: '2026-08-04', cpt: '90834', description: 'Psychotherapy', place_of_service: '11', units: 1, fee_cents: 15000, provider: dana },
          {
            date: '2026-08-11',
            cpt: '90834',
            description: 'Psychotherapy',
            place_of_service: '10',
            units: 1,
            fee_cents: 15000,
            provider: provider ?? jordan,
          },
        ],
        payments: [{ date: '2026-08-05', method: 'Check', amount_cents: 15000 }],
        total_cents: 30000,
        paid_cents: 15000,
      },
    };
  }

  it("shows the practice's billing identity, the provider and the subscriber", () => {
    renderWith(<SuperbillDetailModal superbill={superbill(dana)} onClose={vi.fn()} />);
    const practice = screen.getByRole('region', { name: 'Practice' });
    expect(within(practice).getByText('12-3456789')).toBeInTheDocument();
    expect(within(practice).getByText('Tax ID (EIN)')).toBeInTheDocument();
    expect(within(practice).getByText('1928374650')).toBeInTheDocument();
    expect(within(practice).getByText('The practice (group NPI)')).toBeInTheDocument();
    const provider = screen.getByRole('region', { name: 'Provider' });
    expect(within(provider).getByText('Dana Lee, LCSW')).toBeInTheDocument();
    expect(within(provider).getByText('1234567893')).toBeInTheDocument();
    expect(within(provider).getByText('LC123 (NY)')).toBeInTheDocument();
    const insurance = screen.getByRole('region', { name: 'Insurance' });
    expect(within(insurance).getByText('60054')).toBeInTheDocument();
    expect(within(insurance).getByText('Maria Rivera')).toBeInTheDocument();
    expect(within(insurance).getByText(/Child · born May 6, 1980/)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Provider' })).not.toBeInTheDocument();
  });

  it('names each service’s provider when several clinicians provided them', () => {
    renderWith(<SuperbillDetailModal superbill={superbill(null)} onClose={vi.fn()} />);
    expect(screen.getByText(/Several clinicians provided these services/)).toBeInTheDocument();
    const services = screen.getByRole('region', { name: 'Services' });
    expect(within(services).getByRole('columnheader', { name: 'Provider' })).toBeInTheDocument();
    expect(within(services).getByText('Dana Lee, LCSW')).toBeInTheDocument();
    expect(within(services).getByText('Jordan Kim, LPC')).toBeInTheDocument();
    expect(within(services).getByText('NPI 1234567893')).toBeInTheDocument();
  });
});
