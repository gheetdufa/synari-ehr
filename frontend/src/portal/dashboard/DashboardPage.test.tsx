import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Session } from '../../api/auth';
import { dashboardApi, type DashboardScope, type DashboardSummary, type TodayAppointment } from '../../api/dashboard';
import { WithSession, testSession } from '../../test/session';
import DashboardPage from './DashboardPage';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };
const MINUTE = 60_000;

const basicClinician = testSession({ staff: { role: 'clinician', clinician_access: 'basic' }, capabilities: [] });
const biller = testSession({
  staff: { id: 9, role: 'biller', is_clinician: false, first_name: 'Robin' },
  capabilities: ['view_all_clients', 'billing_all', 'view_reports'],
});

function appointment(overrides: Partial<TodayAppointment> = {}): TodayAppointment {
  const start = new Date(Date.now() + 20 * MINUTE);
  return {
    id: 42,
    kind: 'appointment',
    title_label: 'Alex Rivera',
    clinician: { id: 1, name: 'Dana Lee, LCSW' },
    participants: [{ id: 7, client: { id: 7, name: 'Alex Rivera' } }],
    restricted: false,
    service_description: 'Psychotherapy, 45 min',
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 45 * MINUTE).toISOString(),
    duration_minutes: 45,
    location_type: 'video',
    status: 'scheduled',
    has_video: true,
    ...overrides,
  };
}

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    scope: 'mine',
    today: [appointment()],
    pending_requests: 3,
    unread_messages: 1,
    unread_notifications: 0,
    draft_notes: 0,
    notes_awaiting_cosign: 0,
    appointments_missing_notes: 2,
    pending_forms: 4,
    flagged_forms: 1,
    waiting_room: 2,
    outstanding_cents: 45000,
    client_count: 1,
    ...overrides,
  };
}

function renderPage(session: Session = testSession(), path = '/portal') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
          <DashboardPage />
        </MemoryRouter>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  let getDashboard: MockInstance<typeof dashboardApi.get>;

  beforeEach(() => {
    getDashboard = vi.spyOn(dashboardApi, 'get');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the greeting, today's schedule and linked counters", async () => {
    getDashboard.mockResolvedValue(summary());
    renderPage();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Dana$/);
    expect(await screen.findByText('Alex Rivera')).toBeInTheDocument();
    expect(getDashboard).toHaveBeenCalledWith('mine');
    expect(screen.getByRole('link', { name: /start session with alex rivera/i })).toHaveAttribute('href', '/session/42');

    const requests = screen.getByRole('link', { name: /appointment requests/i });
    expect(requests).toHaveAttribute('href', '/portal/calendar?requests=1');
    expect(within(requests).getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /flagged responses/i })).toHaveClass('bg-red-50');
    expect(screen.getByRole('link', { name: /2 clients are waiting/i })).toHaveAttribute('href', '/portal/telehealth');
    expect(screen.getByRole('link', { name: /outstanding balance \$450\.00/i })).toHaveAttribute('href', '/portal/billing');
    expect(screen.queryByText(/welcome to your practice/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/co-signature/i)).not.toBeInTheDocument();
  });

  it('shows the first-run card and an empty schedule for a new practice', async () => {
    getDashboard.mockResolvedValue(summary({ today: [], waiting_room: 0, flagged_forms: 0, client_count: 0 }));
    renderPage();

    expect(await screen.findByText(/welcome to your practice/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add a client/i })).toHaveAttribute('href', '/portal/clients?new=1');
    expect(screen.getByRole('link', { name: /set up practice/i })).toHaveAttribute('href', '/portal/settings?welcome=1');
    expect(screen.getByText(/nothing on your calendar today/i)).toBeInTheDocument();
  });

  it('switches staff who manage every calendar to the whole practice', async () => {
    const user = userEvent.setup();
    const colleague = appointment({
      id: 43,
      title_label: 'Busy',
      participants: [],
      restricted: true,
      clinician: { id: 2, name: 'Jordan Kim, LPC' },
      service_description: '',
    });
    getDashboard.mockImplementation((scope: DashboardScope) =>
      Promise.resolve(scope === 'practice' ? summary({ scope, today: [appointment(), colleague] }) : summary()),
    );
    renderPage();

    const toggle = await screen.findByRole('group', { name: 'Whose schedule' });
    expect(within(toggle).getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(toggle).getByRole('button', { name: 'Whole practice' }));

    await waitFor(() => expect(getDashboard).toHaveBeenLastCalledWith('practice'));
    const schedule = await screen.findByRole('list', { name: "Today's schedule" });
    await within(schedule).findByText('Busy');
    expect(within(schedule).getByText('Jordan Kim, LPC')).toBeInTheDocument();
    expect(within(schedule).getByText(/Dana Lee, LCSW · Psychotherapy/)).toBeInTheDocument();
    expect(screen.getByText('2 appointments across the practice')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /start session/i })).toHaveLength(1);
  });

  it("doesn't offer the practice schedule without schedule_all", async () => {
    getDashboard.mockResolvedValue(summary());
    renderPage(basicClinician, '/portal?scope=practice');
    expect(await screen.findByText('Alex Rivera')).toBeInTheDocument();
    expect(getDashboard).toHaveBeenCalledWith('mine');
    expect(getDashboard).not.toHaveBeenCalledWith('practice');
    expect(screen.queryByRole('group', { name: 'Whose schedule' })).not.toBeInTheDocument();
  });

  it('shows a group by its title with its members', async () => {
    getDashboard.mockResolvedValue(
      summary({
        today: [
          appointment({
            title_label: 'Tuesday DBT group',
            participants: [
              { id: 1, client: { id: 1, name: 'Alex Rivera' } },
              { id: 2, client: { id: 2, name: 'Sam Park' } },
            ],
          }),
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText('Tuesday DBT group')).toBeInTheDocument();
    expect(screen.getByText('Alex Rivera, Sam Park')).toBeInTheDocument();
  });

  it('links supervisors to the notes waiting for their co-signature', async () => {
    getDashboard.mockResolvedValue(summary({ notes_awaiting_cosign: 3 }));
    renderPage();
    const card = await screen.findByRole('link', { name: /notes awaiting your co-signature/i });
    expect(card).toHaveAttribute('href', '/portal/notes?view=cosign');
    expect(within(card).getByText('3')).toBeInTheDocument();
  });

  it("hides the outstanding balance without billing access and clinical counters from a biller", async () => {
    getDashboard.mockResolvedValue(summary({ outstanding_cents: null, today: [], waiting_room: 0 }));
    renderPage(biller);
    expect(await screen.findByText(/nothing on your calendar today/i)).toBeInTheDocument();
    expect(screen.queryByText(/outstanding balance/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /forms awaiting clients/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /appointment requests/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /unread messages/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /draft notes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /flagged responses/i })).not.toBeInTheDocument();
  });

  it("labels a clinician's own-caseload balance", async () => {
    const ownBilling = testSession({ staff: { role: 'clinician', clinician_access: 'billing' }, capabilities: ['billing_own'] });
    getDashboard.mockResolvedValue(summary({ outstanding_cents: 12000 }));
    renderPage(ownBilling);
    expect(await screen.findByRole('link', { name: /your clients' outstanding balance \$120\.00/i })).toBeInTheDocument();
  });

  it('offers a retry when the dashboard fails to load', async () => {
    getDashboard.mockRejectedValue(new Error('Server unavailable'));
    renderPage();
    expect(await screen.findByText('Server unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
