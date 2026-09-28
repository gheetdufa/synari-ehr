import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '../../api/auth';
import { estimatesApi, type Estimate, type EstimateOptions } from '../../api/estimates';
import { ROLE_SESSIONS, testClient } from '../../test/clients';
import { WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import ClientEstimatesTab from './ClientEstimatesTab';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

function estimate(changes: Partial<Estimate> = {}): Estimate {
  return {
    id: 4,
    client: { id: 7, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' },
    clinician_id: 1,
    clinician_name: 'Dana Lee, LCSW',
    status: 'draft',
    supersedes_id: null,
    superseded_by_id: null,
    change_summary: '',
    reason: 'scheduling',
    due_on: '2026-09-25',
    overdue: true,
    period_start: '2026-10-01',
    period_end: '2027-09-30',
    primary_service: 'Individual psychotherapy',
    scheduled_dates: ['2026-10-08'],
    diagnosis_codes: [],
    items: [
      {
        id: 1,
        description: 'Psychotherapy, 53 minutes',
        service_code: '90837',
        location: 'Telehealth',
        diagnosis_pointers: [],
        unit_fee_cents: 15000,
        quantity: 12,
        frequency: 'Weekly',
        total_cents: 180000,
      },
    ],
    separately_scheduled: [],
    notes: '',
    total_cents: 180000,
    provider: {
      name: 'Dana Lee',
      credentials: 'LCSW',
      type: 'LCSW',
      practice_name: 'Lee Counseling',
      address_lines: [],
      contact: '',
      phone: '',
      email: '',
      npi: '1234567893',
      npi_kind: 'individual',
      tin: '',
      tin_type: 'EIN',
      states: [],
      locations: [],
    },
    missing_provider_fields: [],
    issued_at: null,
    issued_by_name: '',
    delivery_method: 'portal',
    pdf_sha256: '',
    acknowledged_at: null,
    acknowledged_name: '',
    voided_at: null,
    void_reason: '',
    created_at: '2026-09-24T12:00:00Z',
    updated_at: '2026-09-24T12:00:00Z',
    ...changes,
  };
}

const ISSUED = estimate({
  id: 3,
  status: 'issued',
  reason: 'manual',
  due_on: null,
  overdue: false,
  primary_service: 'Initial evaluation',
  issued_at: '2026-09-01T15:00:00Z',
  acknowledged_at: '2026-09-02T15:00:00Z',
  acknowledged_name: 'Alex Rivera',
});

const OPTIONS: EstimateOptions = {
  enabled: true,
  self_pay: true,
  clinicians: [
    {
      id: 1,
      name: 'Dana Lee, LCSW',
      services: [{ service_id: 9, code: '90837', description: 'Psychotherapy, 53 minutes', duration_minutes: 53, rate_cents: 16000 }],
      suggested: null,
    },
  ],
  diagnoses: [{ code: 'F41.1', description: 'Generalized anxiety disorder' }],
  locations: ['Telehealth', 'Main office, 1 Main St, Albany, NY 12207'],
  default_clinician_id: 1,
  missing_client_fields: [],
};

function renderTab(session: Session = ROLE_SESSIONS.owner, client = testClient({ access: { clinical: true, billing: true } })) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter future={ROUTER_FUTURE}>{ui}</MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>
  );
  return render(wrap(<ClientEstimatesTab client={client} />));
}

describe('ClientEstimatesTab', () => {
  beforeEach(() => {
    vi.spyOn(estimatesApi, 'forClient').mockResolvedValue([estimate(), ISSUED]);
    vi.spyOn(estimatesApi, 'options').mockResolvedValue(OPTIONS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists drafts with their due dates and issued estimates with acknowledgments', async () => {
    renderTab();
    const list = await screen.findByRole('list', { name: 'Good faith estimates' });
    const [draft, issued] = within(list).getAllByRole('listitem');
    expect(within(draft).getByText('Draft')).toBeInTheDocument();
    expect(within(draft).getByText('Overdue')).toBeInTheDocument();
    expect(within(draft).getByText(/Session scheduled · due Sep 25, 2026/)).toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: 'Issue' })).toBeInTheDocument();
    expect(within(issued).getByText('Issued')).toBeInTheDocument();
    expect(within(issued).getByText(/acknowledged by Alex Rivera/)).toBeInTheDocument();
    expect(within(issued).getByRole('button', { name: 'Update' })).toBeInTheDocument();
    expect(within(issued).queryByRole('button', { name: 'Issue' })).not.toBeInTheDocument();

    await userEvent.setup().click(within(draft).getByRole('button', { name: 'Details' }));
    expect(within(draft).getByRole('table', { name: 'Estimated services' })).toHaveTextContent('90837');
    expect(within(draft).getByText('NPI 1234567893')).toBeInTheDocument();
  });

  it('validates a new draft, fills a service from the practice list and saves it', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(estimatesApi, 'create').mockResolvedValue(estimate({ id: 10 }));
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'New estimate' }));
    const dialog = await screen.findByRole('dialog', { name: 'New good faith estimate' });
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(within(dialog).getByText(/Describe the main service/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Add service' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Fill Service 1 from a practice service' }), '9');
    expect(within(dialog).getByRole('textbox', { name: 'Primary service *' })).toHaveValue('Psychotherapy, 53 minutes');
    const quantity = within(dialog).getByRole('textbox', { name: 'Quantity' });
    await user.clear(quantity);
    await user.type(quantity, '10');
    await user.click(within(dialog).getByRole('checkbox', { name: /F41.1/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'A (F41.1)' }));
    expect(within(dialog).getByText('$1,600.00')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [clientId, payload] = create.mock.calls[0];
    expect(clientId).toBe(7);
    expect(payload).toMatchObject({
      clinician_id: 1,
      primary_service: 'Psychotherapy, 53 minutes',
      diagnosis_codes: [{ code: 'F41.1', description: 'Generalized anxiety disorder' }],
      items: [{ service_code: '90837', unit_fee_cents: 16000, quantity: 10, diagnosis_pointers: ['A'] }],
    });
  });

  it("won't issue until the provider and client details the estimate needs are in", async () => {
    const user = userEvent.setup();
    vi.spyOn(estimatesApi, 'forClient').mockResolvedValue([
      estimate({ missing_provider_fields: ["the practice's street address in Settings → Practice"] }),
    ]);
    vi.spyOn(estimatesApi, 'options').mockResolvedValue({ ...OPTIONS, missing_client_fields: ['date of birth'] });
    const issue = vi.spyOn(estimatesApi, 'issue');
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue good faith estimate' });
    expect(within(dialog).getByText("Add the client's date of birth to their profile.")).toBeInTheDocument();
    expect(within(dialog).getByText("Add the practice's street address in Settings → Practice.")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Issue estimate' })).toBeDisabled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('issues a ready draft with the chosen delivery method', async () => {
    const user = userEvent.setup();
    const issue = vi.spyOn(estimatesApi, 'issue').mockResolvedValue(estimate({ status: 'issued' }));
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue good faith estimate' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /How the client receives it/ }), 'paper');
    await user.click(within(dialog).getByRole('button', { name: 'Issue estimate' }));
    await waitFor(() => expect(issue).toHaveBeenCalledWith(4, 'paper'));
  });

  it('asks what changed before issuing a replacement, saving it on the draft first', async () => {
    const user = userEvent.setup();
    const replacement = estimate({ id: 5, supersedes_id: 3, reason: 'update' });
    vi.spyOn(estimatesApi, 'forClient').mockResolvedValue([replacement, ISSUED]);
    const update = vi.spyOn(estimatesApi, 'update').mockResolvedValue({ ...replacement, change_summary: 'Weekly sessions' });
    const issue = vi.spyOn(estimatesApi, 'issue').mockResolvedValue({ ...replacement, status: 'issued' });
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue good faith estimate' });
    await user.click(within(dialog).getByRole('button', { name: 'Issue estimate' }));
    expect(within(dialog).getByText('Describe what changed from the estimate this one replaces.')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole('textbox', { name: /What changed/ }), ' Weekly sessions ');
    await user.click(within(dialog).getByRole('button', { name: 'Issue estimate' }));
    await waitFor(() => expect(issue).toHaveBeenCalledWith(5, 'portal'));
    expect(update).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ clinician_id: 1, primary_service: 'Individual psychotherapy', change_summary: 'Weekly sessions' }),
    );
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(issue.mock.invocationCallOrder[0]);
  });

  it("shows a clinician without billing access someone else's estimates read-only", async () => {
    vi.spyOn(estimatesApi, 'options').mockResolvedValue({ ...OPTIONS, clinicians: [] });
    renderTab(ROLE_SESSIONS.clinician, testClient({ access: { clinical: true, billing: false } }));
    const list = await screen.findByRole('list', { name: 'Good faith estimates' });
    expect(within(list).queryByRole('button', { name: 'Issue' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(within(list).getAllByRole('button', { name: /as PDF/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'New estimate' })).not.toBeInTheDocument();
  });
});
