import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditIntegrity } from '../../api/practice';
import type { TeamMember } from '../../api/team';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { ActivitySettings } from './ActivitySettings';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  exportAuditLog: vi.fn(),
  auditIntegrity: vi.fn(),
  team: vi.fn(),
  clients: vi.fn(),
}));

vi.mock('../../api/practice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/practice')>();
  return {
    ...actual,
    practiceApi: {
      ...actual.practiceApi,
      auditLog: mocks.auditLog,
      exportAuditLog: mocks.exportAuditLog,
      auditIntegrity: mocks.auditIntegrity,
    },
  };
});
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, list: mocks.team } };
});
vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, list: mocks.clients } };
});

function event(id: number, changes: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id,
    actor_role: 'staff',
    actor_id: 2,
    actor_name: 'Sam Ortiz',
    client_id: 7,
    client_name: 'Alex Rivera',
    action: 'note.view',
    resource_type: 'note',
    resource_id: 40 + id,
    ip_address: '203.0.113.9',
    user_agent: 'Firefox',
    detail: null,
    created_at: '2026-09-20T14:00:00Z',
    sealed: true,
    ...changes,
  };
}

const VERIFIED: AuditIntegrity = {
  verified: true,
  problem: null,
  head_event_id: 90,
  head_hash: 'abcdef0123456789'.repeat(4),
  sealed_events: 1200,
  unsealed_events: 3,
  last_checkpoint_at: '2026-09-25T04:00:00Z',
};

const SAM = { id: 2, display_name: 'Sam Ortiz, LPC', status: 'active' } as TeamMember;

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={testSession()}>
        <ToastProvider>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <ActivitySettings />
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('ActivitySettings', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.auditLog.mockResolvedValue({ events: [event(1)], next_cursor: null });
    mocks.auditIntegrity.mockResolvedValue(VERIFIED);
    mocks.team.mockResolvedValue([SAM]);
    mocks.clients.mockResolvedValue([]);
    mocks.exportAuditLog.mockResolvedValue(undefined);
  });

  it('shows events with the client they touched and the chain verification', async () => {
    renderLog();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Viewed a note')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Alex Rivera' })).toHaveAttribute('href', '/portal/clients/7');
    expect(await screen.findByText('Tamper-evident log verified')).toBeInTheDocument();
    expect(screen.getByText(/1,200 sealed events, 3 waiting to be sealed/)).toBeInTheDocument();
    expect(mocks.auditLog).toHaveBeenCalledWith({}, undefined);
  });

  it('flags a chain that fails verification', async () => {
    mocks.auditIntegrity.mockResolvedValue({ ...VERIFIED, verified: false, problem: 'Event 55 does not match its hash' });
    renderLog();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The audit log failed verification');
    expect(alert).toHaveTextContent('Event 55 does not match its hash');
  });

  it('filters by team member, activity and dates in my time zone, and exports what is shown', async () => {
    const user = userEvent.setup();
    renderLog();
    await screen.findByRole('table');
    await screen.findByRole('option', { name: 'Sam Ortiz, LPC' });

    await user.selectOptions(screen.getByLabelText('Team member'), '2');
    await user.selectOptions(screen.getByLabelText('Activity'), 'note.');
    await user.type(screen.getByLabelText('From'), '2026-09-01');
    await user.type(screen.getByLabelText('To'), '2026-09-30');

    const filters = {
      actor_id: 2,
      action: 'note.',
      from: '2026-09-01T04:00:00.000Z',
      to: '2026-10-01T04:00:00.000Z',
    };
    await waitFor(() => expect(mocks.auditLog).toHaveBeenLastCalledWith(filters, undefined));

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mocks.exportAuditLog).toHaveBeenCalledWith('csv', filters);
    await user.click(screen.getByRole('button', { name: 'Export NDJSON' }));
    expect(mocks.exportAuditLog).toHaveBeenCalledWith('ndjson', filters);

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(mocks.auditLog).toHaveBeenLastCalledWith({}, undefined));
  });

  it('loads older events with the cursor', async () => {
    mocks.auditLog.mockImplementation((_filters: object, cursor?: number) =>
      Promise.resolve(
        cursor === undefined
          ? { events: [event(2, { action: 'client.view' })], next_cursor: 2 }
          : { events: [event(1, { action: 'auth.login', client_id: null, client_name: '' })], next_cursor: null },
      ),
    );
    const user = userEvent.setup();
    renderLog();
    await screen.findAllByText('Viewed a client');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findAllByText('Signed in')).length).toBeGreaterThan(0);
    expect(mocks.auditLog).toHaveBeenLastCalledWith({}, 2);
    expect(screen.getByText("That's everything.")).toBeInTheDocument();
  });
});
