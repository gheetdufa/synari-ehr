import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalClient } from '../../api/auth';
import type { PortalAppointment } from '../../api/booking';
import { ToastProvider } from '../../ui/Toast';
import ClientHomePage from './ClientHomePage';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const mocks = vi.hoisted(() => ({
  upcoming: vi.fn(),
  forms: vi.fn(),
  billing: vi.fn(),
  unread: vi.fn(),
  client: null as PortalClient | null,
}));

vi.mock('../../api/portalHome', () => ({
  portalHomeApi: {
    upcomingAppointments: mocks.upcoming,
    forms: mocks.forms,
    billingSummary: mocks.billing,
    unreadMessages: mocks.unread,
  },
  portalHomeKeys: {
    upcomingAppointments: ['portal', 'appointments', 'upcoming'],
    forms: ['portal', 'forms', 'list'],
    billingSummary: ['portal', 'billing', 'summary'],
    unreadMessages: ['portal', 'messages', 'unread-count'],
  },
}));

vi.mock('../../auth/ClientAuth', () => ({
  usePortalClient: () => mocks.client,
}));

const MINUTE = 60_000;

function baseClient(permissions: PortalClient['permissions'], changes: Partial<PortalClient> = {}): PortalClient {
  return {
    id: 3,
    first_name: 'Samantha',
    last_name: 'Park',
    preferred_name: 'Sam',
    email: 'sam@example.com',
    clinician_name: 'Dana Lee, LCSW',
    practice_name: 'Calm Harbor Therapy',
    time_zone: 'America/Chicago',
    permissions,
    acting_contact: null,
    idle_timeout_minutes: 30,
    ...changes,
  };
}

function appointmentStartingIn(minutes: number): PortalAppointment {
  const start = new Date(Date.now() + minutes * MINUTE);
  return {
    id: 91,
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 50 * MINUTE).toISOString(),
    status: 'scheduled',
    location_type: 'video',
    location_details: '',
    has_video: true,
    clinician_name: 'Dana Lee, LCSW',
    service_description: 'Psychotherapy',
    is_group: false,
    other_participants: [],
    can_cancel: false,
    cancel_is_late: false,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter future={ROUTER_FUTURE}>
          <ClientHomePage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ClientHomePage', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => typeof mock === 'function' && mock.mockReset());
    mocks.forms.mockResolvedValue([
      { id: 1, kind: 'intake', name: 'Intake', status: 'pending', requires_signature: false, sent_at: '', completed_at: null },
      { id: 2, kind: 'consent', name: 'Consent', status: 'pending', requires_signature: true, sent_at: '', completed_at: null },
      { id: 3, kind: 'assessment', name: 'PHQ-9', status: 'completed', requires_signature: false, sent_at: '', completed_at: '' },
    ]);
    mocks.billing.mockResolvedValue({ balance_cents: 4500, credit_cents: 0, payments_enabled: true, autopay_enabled: false, default_card: null });
    mocks.unread.mockResolvedValue({ count: 1 });
  });

  it('greets the client and shows their next video visit with a Join button', async () => {
    mocks.client = baseClient({ messaging: true, booking: true, billing: true });
    mocks.upcoming.mockResolvedValue([appointmentStartingIn(10)]);
    renderPage();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hi, Sam');
    expect(await screen.findByRole('button', { name: /join video/i })).toBeInTheDocument();
    expect(screen.getByText(/psychotherapy with dana lee, lcsw/i)).toBeInTheDocument();

    const documents = screen.getByRole('link', { name: /documents to complete/i });
    expect(documents).toHaveAttribute('href', '/client/documents');
    expect(await screen.findByText(/forms are waiting for you/i)).toBeInTheDocument();
    expect(await screen.findByText('$45.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /balance/i })).toHaveTextContent(/pay now/i);
    expect(screen.getByRole('link', { name: /messages/i })).toHaveAttribute('href', '/client/messages');
    expect(screen.getAllByRole('link', { name: /request an appointment/i })[0]).toHaveAttribute(
      'href',
      '/client/appointments/book',
    );
  });

  it('hides Join until an hour before, and hides cards the client has no access to', async () => {
    mocks.client = baseClient({ messaging: false, booking: false, billing: false });
    mocks.upcoming.mockResolvedValue([appointmentStartingIn(3 * 60)]);
    renderPage();

    expect(await screen.findByText(/join button appears here an hour before/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join video/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /balance/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /request an appointment/i })).not.toBeInTheDocument();
    expect(mocks.billing).not.toHaveBeenCalled();
    expect(mocks.unread).not.toHaveBeenCalled();
  });

  it('explains when nothing is scheduled', async () => {
    mocks.client = baseClient({ messaging: true, booking: true, billing: true });
    mocks.upcoming.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No upcoming appointments')).toBeInTheDocument();
    expect(screen.getByText('Request a time that works for you and Dana Lee, LCSW will confirm it.')).toBeInTheDocument();
  });

  it("greets a guardian by name and says whose portal it is", async () => {
    mocks.client = baseClient(
      { messaging: true, booking: false, billing: true },
      { acting_contact: { id: 31, name: 'Pat Park' } },
    );
    mocks.upcoming.mockResolvedValue([{ ...appointmentStartingIn(3 * 60), other_participants: ['Jamie'] }]);
    renderPage();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hi, Pat');
    expect(screen.getByText("You're viewing Sam's portal with Dana Lee, LCSW.")).toBeInTheDocument();
    expect(await screen.findByText(/psychotherapy with dana lee, lcsw, together with jamie/i)).toBeInTheDocument();
  });
});
