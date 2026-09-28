import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/auth';
import type { CalendarConnection, CalendarSyncSettings } from '../../api/calendarSync';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { browserNavigation, busyCalendarsSummary, CalendarConnectionsCard, connectErrorMessage } from './CalendarConnectionsCard';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
  connections: vi.fn(),
  connectUrl: vi.fn(),
  calendars: vi.fn(),
  setBusyCalendars: vi.fn(),
  syncNow: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../../api/calendarSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/calendarSync')>()),
  calendarSyncApi: mocks,
}));

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

function syncSettings(overrides: Partial<CalendarSyncSettings> = {}): CalendarSyncSettings {
  return {
    providers: [
      { provider: 'google', label: 'Google Calendar', enabled: true },
      { provider: 'microsoft', label: 'Outlook', enabled: false },
    ],
    include_initials: false,
    ...overrides,
  };
}

function connection(overrides: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 4,
    provider: 'google',
    account_email: 'dana@gmail.test',
    status: 'active',
    busy_calendar_ids: ['primary'],
    last_busy_sync_at: '2026-09-26T14:05:00Z',
    last_error: '',
    last_error_at: null,
    pending_events: 0,
    failed_events: 0,
    created_at: '2026-09-20T10:00:00Z',
    ...overrides,
  };
}

function Search() {
  return <output aria-label="search">{useLocation().search}</output>;
}

function renderCard(session: Session = testSession(), path = '/portal/settings?tab=availability') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
            <CalendarConnectionsCard />
            <Search />
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue(syncSettings());
  mocks.connections.mockResolvedValue([]);
});

describe('CalendarConnectionsCard', () => {
  it('offers only the providers this server is set up for, and sends you to their consent page', async () => {
    const leave = vi.spyOn(browserNavigation, 'leave').mockImplementation(() => undefined);
    mocks.connectUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=x' });
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));

    expect(screen.queryByRole('button', { name: 'Connect Outlook' })).not.toBeInTheDocument();
    expect(mocks.connectUrl.mock.calls[0][0]).toBe('google');
    await waitFor(() => expect(leave).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=x'));
  });

  it('stays out of the way when no calendar service is set up', async () => {
    mocks.settings.mockResolvedValue(
      syncSettings({ providers: [{ provider: 'google', label: 'Google Calendar', enabled: false }] }),
    );
    const { container } = renderCard();
    await waitFor(() => expect(mocks.connections).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('h2')).toBeNull());
  });

  it('shows a connection that needs reconnecting, with what went wrong', async () => {
    mocks.connections.mockResolvedValue([
      connection({ status: 'needs_reauth', failed_events: 2, busy_calendar_ids: ['primary', 'team@group.calendar.google.com'] }),
    ]);
    mocks.connectUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth' });
    vi.spyOn(browserNavigation, 'leave').mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByText('Needs reconnecting')).toBeInTheDocument();
    expect(screen.getByText('dana@gmail.test')).toBeInTheDocument();
    expect(screen.getByText(/Last synced Sat, Sep 26, 10:05 AM · 2 couldn't be synced/)).toBeInTheDocument();
    expect(screen.getByText(/your main calendar and 1 other calendar block your availability/)).toBeInTheDocument();
    expect(screen.getByText(/can no longer reach this calendar/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Google Calendar' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(mocks.connectUrl.mock.calls[0][0]).toBe('google');
  });

  it('explains a failed connection when the provider sends you back, then tidies the URL', async () => {
    renderCard(testSession(), '/portal/settings?tab=availability&calendar_sync=error&provider=google&reason=scopes');

    expect(await screen.findByText(/needs permission to manage its own calendar/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('search')).toHaveTextContent(/^\?tab=availability$/));
  });

  it('confirms a successful connection', async () => {
    renderCard(testSession(), '/portal/settings?tab=availability&calendar_sync=connected&provider=google');
    expect(await screen.findByText(/Google Calendar connected/)).toBeInTheDocument();
  });

  it('disconnects, deleting the Synari calendar unless you keep it', async () => {
    mocks.connections.mockResolvedValue([connection()]);
    mocks.disconnect.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Also delete the Synari calendar/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(4, false));
  });

  it('lets you choose Google calendars that block availability', async () => {
    mocks.connections.mockResolvedValue([connection()]);
    mocks.calendars.mockResolvedValue([{ id: 'primary', name: 'Primary calendar' }]);
    mocks.setBusyCalendars.mockResolvedValue(connection());
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Busy calendars' }));
    await user.type(await screen.findByLabelText('Another Google calendar'), 'team@group.calendar.google.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('checkbox', { name: 'team@group.calendar.google.com' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.setBusyCalendars).toHaveBeenCalledWith(4, ['primary', 'team@group.calendar.google.com']),
    );
  });

  it('asks owners to confirm BAA coverage before showing client initials', async () => {
    mocks.updateSettings.mockResolvedValue(syncSettings({ include_initials: true }));
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('switch', { name: /Show client initials/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Business Associate Agreement/)).toBeInTheDocument();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Show initials' }));

    await waitFor(() => expect(mocks.updateSettings.mock.calls[0][0]).toEqual({ include_initials: true }));
    expect(await screen.findByRole('switch', { name: /Show client initials/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows clinicians without practice settings how events are titled, without the switch', async () => {
    renderCard(testSession({ staff: { role: 'clinician' }, capabilities: [] }));
    expect(await screen.findByText(/say only “Appointment”/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('calendar sync wording', () => {
  it.each([
    [['primary'], 'your main calendar'],
    [['primary', 'a', 'b'], 'your main calendar and 2 other calendars'],
    [['a'], '1 calendar'],
  ])('summarizes busy calendars %j', (ids, expected) => {
    expect(busyCalendarsSummary(ids)).toBe(expected);
  });

  it('explains each connection failure', () => {
    expect(connectErrorMessage('denied', 'microsoft')).toBe("Access to Outlook wasn't allowed, so nothing was connected.");
    expect(connectErrorMessage('expired', 'google')).toMatch(/expired/);
    expect(connectErrorMessage(null, 'google')).toMatch(/Google Calendar had a problem/);
  });
});
