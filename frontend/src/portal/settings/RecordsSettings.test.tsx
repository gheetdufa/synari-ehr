import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capability } from '../../api/auth';
import type { PracticeSettings } from '../../api/practice';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import ClientAccessHistoryTab from '../clients/ClientAccessHistoryTab';
import { RecordsSettings, retentionProblem } from './RecordsSettings';

const mocks = vi.hoisted(() => ({ updateSettings: vi.fn(), retentionReport: vi.fn(), accessHistory: vi.fn() }));

vi.mock('../../api/practice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/practice')>();
  return {
    ...actual,
    practiceApi: { ...actual.practiceApi, updateSettings: mocks.updateSettings, retentionReport: mocks.retentionReport },
  };
});
vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, accessHistory: mocks.accessHistory } };
});

const SETTINGS = { record_retention_years: 7 } as PracticeSettings;

function renderWith(node: ReactNode, capabilities?: Capability[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={testSession(capabilities ? { capabilities } : {})}>
        <ToastProvider>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{node}</MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.retentionReport.mockResolvedValue([]);
});

describe('RecordsSettings', () => {
  it('accepts whole years from 6 to 100', () => {
    expect(retentionProblem(6)).toBeNull();
    expect(retentionProblem(100)).toBeNull();
    expect(retentionProblem(5)).toMatch(/from 6 to 100/);
    expect(retentionProblem(7.5)).toMatch(/whole number/);
    expect(retentionProblem(Number.NaN)).toMatch(/whole number/);
  });

  it('saves the retention period and lists archived clients past it', async () => {
    mocks.retentionReport.mockResolvedValue([
      {
        client: { id: 7, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' },
        status: 'archived',
        last_activity_at: '2018-03-01T15:00:00Z',
        retention_ends_on: '2025-03-01',
      },
    ]);
    mocks.updateSettings.mockResolvedValue({ ...SETTINGS, record_retention_years: 10 });
    const user = userEvent.setup();
    renderWith(<RecordsSettings settings={SETTINGS} />);

    expect(await screen.findByRole('link', { name: 'Alex Rivera' })).toHaveAttribute('href', '/portal/clients/7');
    expect(screen.getByText(/Synari doesn't delete records/)).toBeInTheDocument();

    const years = screen.getByLabelText(/Keep records for/);
    await user.clear(years);
    await user.type(years, '5');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText(/from 6 to 100/)).toBeInTheDocument();
    expect(mocks.updateSettings).not.toHaveBeenCalled();

    await user.clear(years);
    await user.type(years, '10');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({ record_retention_years: 10 }));
  });

  it('is read-only without manage_practice and skips the report', () => {
    renderWith(<RecordsSettings settings={SETTINGS} />, []);
    expect(screen.getByLabelText(/Keep records for/)).toBeDisabled();
    expect(screen.queryByText('Records past retention')).not.toBeInTheDocument();
    expect(mocks.retentionReport).not.toHaveBeenCalled();
  });
});

describe('ClientAccessHistoryTab', () => {
  it("lists who opened the client's record, without a client column", async () => {
    mocks.accessHistory.mockResolvedValue({
      events: [
        {
          id: 3,
          actor_role: 'staff',
          actor_id: 2,
          actor_name: 'Sam Ortiz',
          client_id: 7,
          client_name: 'Alex Rivera',
          action: 'note.view',
          resource_type: 'note',
          resource_id: 12,
          ip_address: '198.51.100.4',
          user_agent: '',
          detail: null,
          created_at: '2026-09-20T14:00:00Z',
          sealed: true,
        },
        {
          id: 2,
          actor_role: 'client',
          actor_id: 7,
          actor_name: '',
          client_id: 7,
          client_name: 'Alex Rivera',
          action: 'portal.login',
          resource_type: '',
          resource_id: null,
          ip_address: '198.51.100.9',
          user_agent: '',
          detail: null,
          created_at: '2026-09-19T14:00:00Z',
          sealed: false,
        },
      ],
      next_cursor: null,
    });
    renderWith(<ClientAccessHistoryTab clientId={7} />);
    const table = await screen.findByRole('table', { name: 'Access history' });
    expect(table).toHaveTextContent('Viewed a note');
    expect(table).toHaveTextContent('Sam Ortiz');
    expect(table).toHaveTextContent('Signed in to the client portal');
    expect(within(table).queryByRole('columnheader', { name: 'Client' })).not.toBeInTheDocument();
    // The client is named as who signed in.
    expect(table).toHaveTextContent('Alex Rivera');
    expect(mocks.accessHistory).toHaveBeenCalledWith(7, undefined);
  });
});
