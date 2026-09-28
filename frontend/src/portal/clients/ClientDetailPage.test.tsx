import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import type { ClientDetail } from '../../api/clients';
import { formatTime } from '../../lib/format';
import { ROLE_SESSIONS, testClient } from '../../test/clients';
import { WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import ClientDetailPage from './ClientDetailPage';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  insurance: vi.fn(),
  invite: vi.fn(),
  exportRecord: vi.fn(),
  myGrants: vi.fn(),
  requestEmergency: vi.fn(),
}));

vi.mock('../../api/emergencyAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/emergencyAccess')>();
  return {
    ...actual,
    emergencyAccessApi: { ...actual.emergencyAccessApi, mine: mocks.myGrants, request: mocks.requestEmergency },
  };
});

vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return {
    ...actual,
    clientsApi: {
      ...actual.clientsApi,
      get: mocks.get,
      update: mocks.update,
      invite: mocks.invite,
      exportRecord: mocks.exportRecord,
      insurance: { ...actual.clientsApi.insurance, list: mocks.insurance },
    },
  };
});
vi.mock('../../api/practice', () => ({
  practiceApi: { services: () => Promise.resolve([]) },
  practiceKeys: { services: ['practice', 'services'] },
}));
vi.mock('../../lib/usePublicConfig', () => ({
  usePublicConfig: () => ({ sms_enabled: false, email_enabled: true, payments_enabled: false, telehealth_enabled: true, ai_enabled: false }),
}));
vi.mock('./ClientAppointmentsTab', () => ({ default: ({ clientId }: { clientId: number }) => <p>Appointments tab {clientId}</p> }));
vi.mock('../notes/ClientNotesTab', () => ({ default: ({ clientId }: { clientId: number }) => <p>Notes tab {clientId}</p> }));
vi.mock('../forms/ClientDocumentsTab', () => ({ default: ({ clientId }: { clientId: number }) => <p>Documents tab {clientId}</p> }));
vi.mock('../billing/ClientBillingTab', () => ({ default: ({ clientId }: { clientId: number }) => <p>Billing tab {clientId}</p> }));
vi.mock('../records/ClientPrivacyTab', () => ({ default: ({ clientId }: { clientId: number }) => <p>Privacy tab {clientId}</p> }));
vi.mock('./ClientAccessHistoryTab', () => ({
  default: ({ clientId }: { clientId: number }) => <p>Access history tab {clientId}</p>,
}));
vi.mock('../estimates/ClientEstimatesTab', () => ({
  default: ({ client }: { client: { id: number } }) => <p>Estimates tab {client.id}</p>,
}));

const alex = testClient({ sms_reminders: true, sms_opted_out: true });

function renderChart(path: string, session: Session = ROLE_SESSIONS.owner) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
            <Routes>
              <Route path="/portal/clients/:clientId" element={<ClientDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

function section(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('.rounded-xl') as HTMLElement;
}

describe('ClientDetailPage', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.get.mockResolvedValue(alex);
    mocks.insurance.mockResolvedValue([]);
    mocks.myGrants.mockResolvedValue([]);
  });

  it('opens the documents tab for ?tab=forms and shows quick actions', async () => {
    renderChart('/portal/clients/7?tab=forms');
    expect(await screen.findByText('Documents tab 7')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Alex Rivera');
    expect(screen.getByText('Dana Lee, LCSW')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /message/i })).toHaveAttribute('href', '/portal/messaging?client=7');
    expect(screen.getByRole('link', { name: /schedule/i })).toHaveAttribute('href', '/portal/calendar?new=1&client=7');
    expect(screen.getByRole('link', { name: /new note/i })).toHaveAttribute('href', '/portal/notes?new=1&client=7');
    expect(screen.getByRole('button', { name: /export record/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send portal invite/i })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('tab', { name: 'Billing' }));
    expect(await screen.findByText('Billing tab 7')).toBeInTheDocument();
  });

  it('saves only the fields that changed in a section', async () => {
    mocks.update.mockImplementation((_id: number, changes: Partial<ClientDetail>) => Promise.resolve({ ...alex, ...changes }));
    const user = userEvent.setup();
    renderChart('/portal/clients/7');

    expect(await screen.findByText(/opted out via stop/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /edit personal/i }));
    const form = screen.getByRole('form', { name: /edit personal/i });
    const pronouns = within(form).getByLabelText(/pronouns/i);
    await user.clear(pronouns);
    await user.type(pronouns, 'she/her');
    await user.click(within(form).getByRole('checkbox', { name: /client is a minor/i }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(7, { pronouns: 'she/her', is_minor: true }));
    expect(await screen.findByText('Personal saved')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /edit personal/i })).not.toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
    expect(within(heading).getByText('Minor')).toBeInTheDocument();
  });

  it('asks for confirmation before archiving', async () => {
    mocks.update.mockResolvedValue({ ...alex, status: 'archived' });
    const user = userEvent.setup();
    renderChart('/portal/clients/7');

    await user.click(await screen.findByRole('radio', { name: /archived/i }));
    await user.click(screen.getByRole('button', { name: /archive client/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/revokes their client portal access immediately/i)).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /archive client/i }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(7, { status: 'archived' }));
  });

  it('shows a biller the billing side only: diagnoses but not internal notes, no clinical actions', async () => {
    mocks.get.mockResolvedValue({
      ...alex,
      internal_notes: null,
      diagnosis_codes: [{ code: 'F41.1', description: 'Generalized anxiety disorder' }],
      access: { clinical: false, billing: true },
    });
    renderChart('/portal/clients/7?tab=notes', ROLE_SESSIONS.biller);

    expect(await screen.findByText('Generalized anxiety disorder')).toBeInTheDocument();
    const clinical = section('Clinical');
    expect(within(clinical).getByText('Not available to your role')).toBeInTheDocument();
    expect(within(clinical).queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Notes' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Billing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit billing/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit personal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update status/i })).not.toBeInTheDocument();
    for (const action of [/^message$/i, /^schedule$/i, /new note/i]) {
      expect(screen.queryByRole('link', { name: action })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /export record/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send portal invite/i })).not.toBeInTheDocument();
    expect(await screen.findByText('No insurance on file')).toBeInTheDocument();
  });

  it('shows a scheduler the profile, with clinical and billing details marked unavailable', async () => {
    mocks.get.mockResolvedValue({ ...alex, internal_notes: null, diagnosis_codes: null, access: { clinical: false, billing: false } });
    renderChart('/portal/clients/7', ROLE_SESSIONS.scheduler);

    const clinical = await waitFor(() => section('Clinical'));
    expect(within(clinical).getAllByText('Not available to your role')).toHaveLength(2);
    expect(within(section('Insurance')).getByText('Not available to your role')).toBeInTheDocument();
    expect(mocks.insurance).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /edit billing/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit personal/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit care team/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add contact/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^schedule$/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^message$/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Appointments', 'Documents']);
  });

  it('shows the access history to audit-log reviewers and the primary clinician only', async () => {
    renderChart('/portal/clients/7?tab=access');
    expect(await screen.findByText('Access history tab 7')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Privacy requests' })).toBeInTheDocument();
  });

  it('hides the access history from a care-team clinician who is not the primary clinician', async () => {
    mocks.get.mockResolvedValue({
      ...alex,
      care_team: [
        { staff_id: 1, name: 'Dana Lee, LCSW', is_primary: true },
        { staff_id: 2, name: 'Sam Ortiz, LPC', is_primary: false },
      ],
      access: { clinical: true, billing: false },
    });
    renderChart('/portal/clients/7?tab=access', ROLE_SESSIONS.clinician);
    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Access history' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Privacy requests' })).toBeInTheDocument();
  });

  it('lets the primary clinician open the access history', async () => {
    mocks.get.mockResolvedValue({
      ...alex,
      care_team: [{ staff_id: 2, name: 'Sam Ortiz, LPC', is_primary: true }],
      access: { clinical: true, billing: false },
    });
    renderChart('/portal/clients/7?tab=access', ROLE_SESSIONS.clinician);
    expect(await screen.findByText('Access history tab 7')).toBeInTheDocument();
  });

  it('asks why the record is exported, and needs a recipient and description for other disclosures', async () => {
    mocks.exportRecord.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderChart('/portal/clients/7');

    await user.click(await screen.findByRole('button', { name: /export record/i }));
    let dialog = screen.getByRole('dialog', { name: /export this client's record/i });
    await user.click(within(dialog).getByRole('radio', { name: /other disclosure/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    expect(within(dialog).getByText('Enter who will receive the record')).toBeInTheDocument();
    expect(within(dialog).getByText('Describe what is disclosed and why')).toBeInTheDocument();
    expect(mocks.exportRecord).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole('textbox', { name: /^Recipient\W*$/ }), 'County Court');
    await user.type(within(dialog).getByLabelText(/What is disclosed and why/), 'Records under subpoena 24-113');
    await user.type(within(dialog).getByLabelText(/Legal basis/), 'Court order');
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(mocks.exportRecord).toHaveBeenCalledWith(7, {
        purpose: 'other',
        recipient_name: 'County Court',
        recipient_address: '',
        description: 'Records under subpoena 24-113',
        legal_basis: 'Court order',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /export record/i }));
    dialog = screen.getByRole('dialog', { name: /export this client's record/i });
    expect(within(dialog).getByRole('radio', { name: /^treatment/i })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(mocks.exportRecord).toHaveBeenLastCalledWith(7, { purpose: 'treatment' }));
  });

  it("shows not found to someone who doesn't see clients", async () => {
    mocks.get.mockRejectedValue(new ApiError(404, 'Client not found'));
    renderChart('/portal/clients/999', ROLE_SESSIONS.scheduler);
    expect(await screen.findByText("This client doesn't exist or isn't part of your practice.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /emergency access/i })).not.toBeInTheDocument();
    expect(mocks.myGrants).not.toHaveBeenCalled();
  });

  describe('emergency access', () => {
    const inFourHours = () => new Date(Date.now() + 4 * 60 * 60_000).toISOString();

    it('lets a clinician open a chart that is not available to them, with a reason', async () => {
      const user = userEvent.setup();
      const grant = { id: 41, client_id: 7, created_at: new Date().toISOString(), expires_at: inFourHours() };
      mocks.get.mockRejectedValueOnce(new ApiError(404, 'Client not found')).mockResolvedValue(alex);
      mocks.myGrants.mockResolvedValueOnce([]).mockResolvedValue([grant]);
      mocks.requestEmergency.mockResolvedValue(grant);
      renderChart('/portal/clients/7', ROLE_SESSIONS.clinician);

      expect(await screen.findByRole('heading', { name: "This chart isn't available to you" })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /emergency access/i }));
      const dialog = screen.getByRole('dialog', { name: 'Emergency access' });
      expect(within(dialog).getByText(/owners and the client's clinician are notified/)).toBeInTheDocument();
      const open = within(dialog).getByRole('button', { name: 'Open chart' });
      expect(open).toBeDisabled();

      const reason = within(dialog).getByLabelText(/Reason/);
      await user.type(reason, 'Client in crisis');
      expect(within(dialog).getByText('4 more characters needed (at least 20)')).toBeInTheDocument();
      expect(open).toBeDisabled();
      await user.type(reason, ', Dana away');
      expect(within(dialog).getByText('27/1000 characters')).toBeInTheDocument();
      await user.click(open);

      await waitFor(() => expect(mocks.requestEmergency).toHaveBeenCalledWith(7, 'Client in crisis, Dana away'));
      expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Alex Rivera');
      const expires = formatTime(grant.expires_at, ROLE_SESSIONS.clinician.staff.time_zone);
      expect(await screen.findByText(`Emergency access until ${expires}`)).toBeInTheDocument();
      expect(screen.getByText(/Every action is logged/)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it("offers it when a clinician sees the profile but not the clinical record, and shows the server's refusal", async () => {
      const user = userEvent.setup();
      mocks.get.mockResolvedValue({ ...alex, internal_notes: null, access: { clinical: false, billing: false } });
      mocks.requestEmergency.mockRejectedValue(new ApiError(429, 'Too many emergency access requests. Try again later.'));
      renderChart('/portal/clients/7', ROLE_SESSIONS.clinician);

      expect(await screen.findByText("This client's clinical record isn't available to you")).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Notes' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /emergency access/i }));
      const dialog = screen.getByRole('dialog', { name: 'Emergency access' });
      await user.type(within(dialog).getByLabelText(/Reason/), 'Crisis call, clinician unreachable');
      await user.click(within(dialog).getByRole('button', { name: 'Open chart' }));

      expect(await within(dialog).findByText('Too many emergency access requests. Try again later.')).toBeInTheDocument();
    });

    it('shows the banner while a grant is active and no offer for charts already open', async () => {
      mocks.myGrants.mockResolvedValue([{ id: 41, client_id: 7, created_at: new Date().toISOString(), expires_at: inFourHours() }]);
      renderChart('/portal/clients/7', ROLE_SESSIONS.clinician);
      expect(await screen.findByText(/^Emergency access until/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /emergency access/i })).not.toBeInTheDocument();
    });

    it("doesn't offer exporting the record while the chart is open through emergency access", async () => {
      mocks.myGrants.mockResolvedValue([{ id: 41, client_id: 7, created_at: new Date().toISOString(), expires_at: inFourHours() }]);
      renderChart('/portal/clients/7', ROLE_SESSIONS.clinician);
      expect(await screen.findByText(/Exporting the record isn't included/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /new note/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /export record/i })).not.toBeInTheDocument();
    });

    it('never offers it to staff who are not clinicians', async () => {
      mocks.get.mockResolvedValue({ ...alex, internal_notes: null, diagnosis_codes: null, access: { clinical: false, billing: false } });
      renderChart('/portal/clients/7', ROLE_SESSIONS.scheduler);
      expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Alex Rivera');
      expect(screen.queryByText(/clinical record isn't available/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /emergency access/i })).not.toBeInTheDocument();
    });
  });
});
