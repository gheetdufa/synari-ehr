import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import type { ClientSummary } from '../../api/clients';
import { ROLE_SESSIONS, testClient } from '../../test/clients';
import { page } from '../../test/page';
import { WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import ClientsPage from './ClientsPage';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), team: vi.fn() }));

vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, list: mocks.list, create: mocks.create } };
});
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, list: mocks.team } };
});

const alex: ClientSummary = {
  id: 7,
  first_name: 'Alex',
  last_name: 'Rivera',
  preferred_name: 'Lex',
  status: 'active',
  email: 'alex@example.com',
  phone: '555-0100',
  date_of_birth: '1990-06-15',
  created_at: '2026-01-01T00:00:00Z',
  care_team: [
    { staff_id: 1, name: 'Dana Lee, LCSW', is_primary: true },
    { staff_id: 3, name: 'Jo Park, LMFT', is_primary: false },
  ],
};

const clinician = (id: number, display_name: string, is_clinician = true) => ({
  id,
  display_name,
  first_name: display_name.split(' ')[0],
  last_name: '',
  status: 'active',
  is_clinician,
});
const TEAM = [clinician(1, 'Dana Lee, LCSW'), clinician(3, 'Jo Park, LMFT'), clinician(5, 'Robin Hale', false)];

function Chart() {
  const { clientId } = useParams();
  return <p>Chart for client {clientId}</p>;
}

function renderPage(path = '/portal/clients', session: Session = ROLE_SESSIONS.owner) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
            <Routes>
              <Route path="/portal/clients" element={<ClientsPage />} />
              <Route path="/portal/clients/:clientId" element={<Chart />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('ClientsPage', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.team.mockResolvedValue(TEAM);
  });

  it('lists active clients with preferred names and clinicians, and searches on the server', async () => {
    mocks.list.mockResolvedValue(page([alex]));
    const user = userEvent.setup();
    renderPage();

    expect((await screen.findAllByText('Lex (Alex) Rivera')).length).toBeGreaterThan(0);
    expect(screen.getByRole('columnheader', { name: 'Clinician' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Dana Lee, LCSW +1' })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith({ status: 'active', q: undefined, clinician_id: undefined, limit: 50, offset: 0 });

    await user.type(screen.getByRole('searchbox', { name: /search clients/i }), 'riv');
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ status: 'active', q: 'riv', clinician_id: undefined, limit: 50, offset: 0 }));

    await user.selectOptions(screen.getByRole('combobox', { name: /filter by status/i }), 'all');
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ status: undefined, q: 'riv', clinician_id: undefined, limit: 50, offset: 0 }));
  });

  it('counts every matching client and loads more on request', async () => {
    const bea: ClientSummary = { ...alex, id: 8, first_name: 'Bea', preferred_name: '', last_name: 'Stone' };
    mocks.list.mockResolvedValueOnce(page([alex], 2)).mockResolvedValueOnce(page([bea], 2));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('2 clients')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 2 clients')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findAllByText('Bea Stone')).length).toBeGreaterThan(0);
    expect(mocks.list).toHaveBeenLastCalledWith({ status: 'active', q: undefined, clinician_id: undefined, limit: 50, offset: 1 });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it("filters by clinician for roles that see every client, but not in a clinician's own caseload", async () => {
    mocks.list.mockResolvedValue(page([alex]));
    const user = userEvent.setup();
    const { unmount } = renderPage();

    const filter = await screen.findByRole('combobox', { name: /filter by clinician/i });
    await within(filter).findByRole('option', { name: 'Jo Park, LMFT' });
    expect(within(filter).queryByRole('option', { name: 'Robin Hale' })).not.toBeInTheDocument();
    await user.selectOptions(filter, '3');
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ status: 'active', q: undefined, clinician_id: 3, limit: 50, offset: 0 }));
    unmount();

    renderPage('/portal/clients?clinician=3', ROLE_SESSIONS.clinician);
    await screen.findAllByText('Lex (Alex) Rivera');
    expect(screen.queryByRole('combobox', { name: /filter by clinician/i })).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith({ status: 'active', q: undefined, clinician_id: undefined, limit: 50, offset: 0 });
  });

  it("doesn't offer to add clients to a biller", async () => {
    mocks.list.mockResolvedValue(page([]));
    renderPage('/portal/clients?new=1', ROLE_SESSIONS.biller);
    expect(await screen.findByText('No clients yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add client/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('makes a scheduler choose the primary clinician and leaves out billing details', async () => {
    mocks.list.mockResolvedValue(page([]));
    mocks.create.mockResolvedValue(testClient({ id: 12, first_name: 'Sam' }));
    const user = userEvent.setup();
    renderPage('/portal/clients?new=1', ROLE_SESSIONS.scheduler);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/billing type/i)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/legal first name/i), 'Sam');
    await user.type(within(dialog).getByLabelText(/legal last name/i), 'Lee');
    await user.click(within(dialog).getByRole('button', { name: /^add client$/i }));
    expect(within(dialog).getByText('Choose a primary clinician')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();

    const primary = within(dialog).getByRole('combobox', { name: /primary clinician/i });
    await within(primary).findByRole('option', { name: 'Jo Park, LMFT' });
    await user.selectOptions(primary, '3');
    await user.click(within(dialog).getByRole('button', { name: /^add client$/i }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ primary_clinician_id: 3 })));
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('billing_type');
    expect(await screen.findByText('Chart for client 12')).toBeInTheDocument();
  });

  it('adds a clinician-owner\'s client to their own caseload by default, then opens the new chart', async () => {
    mocks.list.mockResolvedValue(page([]));
    mocks.create
      .mockRejectedValueOnce(new ApiError(409, 'Another client already uses this email'))
      .mockResolvedValueOnce(testClient({ id: 12, first_name: 'Sam' }));
    const user = userEvent.setup();
    renderPage('/portal/clients?new=1');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Add client' })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: /primary clinician/i })).toHaveValue('1'));
    const invite = within(dialog).getByRole('checkbox', { name: /send portal invitation/i });
    expect(invite).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/legal first name/i), 'Sam');
    await user.type(within(dialog).getByLabelText(/legal last name/i), 'Lee');
    await user.type(within(dialog).getByLabelText(/^email/i), 'taken@example.com');
    expect(invite).toBeEnabled();
    await user.click(invite);
    await user.selectOptions(within(dialog).getByLabelText(/billing type/i), 'insurance');
    await user.click(within(dialog).getByRole('button', { name: /^add client$/i }));

    expect(await within(dialog).findByText('Another client already uses this email')).toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: 'Sam',
        last_name: 'Lee',
        email: 'taken@example.com',
        primary_clinician_id: 1,
        billing_type: 'insurance',
        send_portal_invite: true,
      }),
    );

    const email = within(dialog).getByLabelText(/^email/i);
    await user.clear(email);
    await user.type(email, 'sam@example.com');
    await user.click(within(dialog).getByRole('button', { name: /^add client$/i }));

    expect(await screen.findByText('Chart for client 12')).toBeInTheDocument();
  });

  it('validates required names before calling the API', async () => {
    mocks.list.mockResolvedValue(page([alex]));
    const user = userEvent.setup();
    renderPage('/portal/clients', ROLE_SESSIONS.clinician);
    await screen.findAllByText('Lex (Alex) Rivera');

    await user.click(screen.getByRole('button', { name: /add client/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('combobox', { name: /primary clinician/i })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^add client$/i }));

    expect(within(dialog).getByText('Enter a first name')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a last name')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
