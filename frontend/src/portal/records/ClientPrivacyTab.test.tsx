import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Disclosure } from '../../api/records';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { todayIn } from '../clients/clientHelpers';
import ClientPrivacyTab from './ClientPrivacyTab';
import { disclosureErrors } from './DisclosuresSection';
import { recordRequestErrors } from './NewRequestModals';

const mocks = vi.hoisted(() => ({
  requests: vi.fn(),
  createRequest: vi.fn(),
  amendments: vi.fn(),
  createAmendment: vi.fn(),
  disclosures: vi.fn(),
  createDisclosure: vi.fn(),
  updateDisclosure: vi.fn(),
  removeDisclosure: vi.fn(),
  disclosureReport: vi.fn(),
  downloadDisclosureReport: vi.fn(),
}));

vi.mock('../../api/records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/records')>();
  return { ...actual, recordsApi: { ...actual.recordsApi, ...mocks } };
});

function disclosure(id: number, changes: Partial<Disclosure> = {}): Disclosure {
  return {
    id,
    client_id: 7,
    disclosed_on: '2026-05-04',
    recipient_name: 'County Court',
    recipient_address: '1 Main St',
    description: 'Treatment dates',
    purpose: 'Subpoena response',
    legal_basis: 'Court order',
    source: 'manual',
    record_request_id: null,
    recorded_by: { id: 1, name: 'Dana Lee, LCSW' },
    created_at: '2026-05-04T15:00:00Z',
    ...changes,
  };
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={testSession()}>
        <ToastProvider>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <ClientPrivacyTab clientId={7} />
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.requests.mockResolvedValue([]);
  mocks.amendments.mockResolvedValue([]);
  mocks.disclosures.mockResolvedValue([]);
});

describe('validation', () => {
  it('needs a scope, a recipient for third parties and a past or present date', () => {
    const base = { scope: 'Everything', delivery: 'portal' as const, recipient: '', receivedOn: '2026-09-01' };
    expect(recordRequestErrors(base, '2026-09-26')).toEqual({});
    expect(recordRequestErrors({ ...base, scope: ' ', delivery: 'third_party' }, '2026-09-26')).toEqual({
      scope: 'Describe what the client asked for',
      recipient: 'Say who to send it to and where',
    });
    expect(recordRequestErrors({ ...base, receivedOn: '2026-10-01' }, '2026-09-26')).toEqual({
      receivedOn: "The request can't arrive in the future",
    });
  });

  it('needs the date, recipient, description and purpose of a disclosure', () => {
    const empty = { disclosed_on: '', recipient_name: '', recipient_address: '', description: '', purpose: '', legal_basis: '' };
    expect(Object.keys(disclosureErrors(empty, '2026-09-26')).sort()).toEqual([
      'description',
      'disclosed_on',
      'purpose',
      'recipient_name',
    ]);
  });
});

describe('ClientPrivacyTab', () => {
  it("shows the client's requests and records one on their behalf", async () => {
    mocks.createRequest.mockResolvedValue({});
    const user = userEvent.setup();
    renderTab();

    await screen.findByText('No requests');
    expect(mocks.requests).toHaveBeenCalledWith({ client_id: 7 });
    expect(mocks.amendments).toHaveBeenCalledWith({ client_id: 7 });

    await user.click(screen.getByRole('button', { name: 'Record request' }));
    const dialog = screen.getByRole('dialog', { name: 'Record a request for records' });
    await user.type(within(dialog).getByLabelText(/What they asked for/), 'Notes from 2025');
    await user.click(within(dialog).getByRole('radio', { name: /Send to someone the client named/ }));
    await user.type(within(dialog).getByLabelText(/^Recipient/), 'Dr. Kim, 12 Elm St');
    await user.click(within(dialog).getByRole('button', { name: 'Save request' }));
    expect(mocks.createRequest).toHaveBeenCalledWith(7, {
      scope: 'Notes from 2025',
      delivery: 'third_party',
      recipient: 'Dr. Kim, 12 Elm St',
      received_at: todayIn('America/New_York'),
    });
  });

  it('records an amendment request on the client’s behalf', async () => {
    mocks.createAmendment.mockResolvedValue({});
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Record amendment request' }));
    const dialog = screen.getByRole('dialog', { name: 'Record an amendment request' });
    await user.type(within(dialog).getByLabelText(/^Request/), 'Wrong birth date on the intake note');
    await user.click(within(dialog).getByRole('button', { name: 'Save request' }));
    expect(mocks.createAmendment).toHaveBeenCalledWith(7, { request: 'Wrong birth date on the intake note' });
  });

  it('adds, edits and removes manual disclosures, but not ones from record requests or exports', async () => {
    mocks.disclosures.mockResolvedValue([
      disclosure(1),
      disclosure(2, { recipient_name: 'Dr. Kim', source: 'record_request', record_request_id: 4 }),
      disclosure(3, { recipient_name: 'State board', source: 'export' }),
    ]);
    mocks.createDisclosure.mockResolvedValue(disclosure(3));
    mocks.updateDisclosure.mockResolvedValue(disclosure(1));
    mocks.removeDisclosure.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderTab();

    const list = await screen.findByRole('list', { name: 'Disclosures' });
    expect(within(list).getByRole('button', { name: 'Edit disclosure to County Court' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Edit disclosure to Dr. Kim' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Remove disclosure to State board' })).not.toBeInTheDocument();
    expect(within(list).getByText(/From a record request/)).toBeInTheDocument();
    expect(within(list).getByText(/From a record export/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Record disclosure' }));
    let dialog = screen.getByRole('dialog', { name: 'Record a disclosure' });
    await user.type(within(dialog).getByLabelText(/^Recipient\W*$/), 'State health department');
    await user.type(within(dialog).getByLabelText(/What was disclosed/), 'Diagnosis and dates of service');
    await user.type(within(dialog).getByLabelText(/^Purpose/), 'Mandatory public health report');
    await user.type(within(dialog).getByLabelText(/Legal basis/), 'Public health');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(mocks.createDisclosure).toHaveBeenCalledWith(7, {
      disclosed_on: todayIn('America/New_York'),
      recipient_name: 'State health department',
      recipient_address: '',
      description: 'Diagnosis and dates of service',
      purpose: 'Mandatory public health report',
      legal_basis: 'Public health',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(list).getByRole('button', { name: 'Edit disclosure to County Court' }));
    dialog = screen.getByRole('dialog', { name: 'Edit disclosure' });
    const purpose = within(dialog).getByLabelText(/^Purpose/);
    await user.clear(purpose);
    await user.type(purpose, 'Court-ordered evaluation');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(mocks.updateDisclosure).toHaveBeenCalledWith(1, expect.objectContaining({ purpose: 'Court-ordered evaluation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(list).getByRole('button', { name: 'Remove disclosure to County Court' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(mocks.removeDisclosure).toHaveBeenCalledWith(1);
  });

  it('shows the six-year accounting and downloads it', async () => {
    mocks.disclosureReport.mockResolvedValue({
      client_id: 7,
      client_name: 'Alex Rivera',
      practice_name: 'Lee Counseling',
      period_start: '2020-09-26',
      period_end: '2026-09-26',
      generated_at: '2026-09-26T12:00:00Z',
      disclosures: [disclosure(1)],
    });
    mocks.downloadDisclosureReport.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Accounting report' }));
    const dialog = screen.getByRole('dialog', { name: 'Accounting of disclosures' });
    expect(await within(dialog).findByText(/Subpoena response/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Lee Counseling/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Download PDF' }));
    expect(mocks.downloadDisclosureReport).toHaveBeenCalledWith(7, 'pdf');
    await user.click(within(dialog).getByRole('button', { name: 'Download CSV' }));
    expect(mocks.downloadDisclosureReport).toHaveBeenCalledWith(7, 'csv');
  });
});
