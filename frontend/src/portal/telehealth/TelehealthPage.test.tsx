import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appointmentsApi } from '../../api/appointments';
import type { Capability, PublicConfig, StaffMember } from '../../api/auth';
import { telehealthApi } from '../../api/telehealth';
import { participant, videoAppointment } from '../../telehealth/appointment.fixture';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import TelehealthPage from './TelehealthPage';

vi.mock('../../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/auth')>();
  return {
    ...actual,
    fetchPublicConfig: vi.fn(
      async (): Promise<PublicConfig> => ({
        registration_enabled: true,
        email_enabled: true,
        sms_enabled: false,
        payments_enabled: false,
        telehealth_enabled: true,
        ai_enabled: false,
        livekit_url: 'ws://localhost:7880',
        currency: 'USD',
      }),
    ),
  };
});

vi.mock('../../api/appointments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/appointments')>();
  return { ...actual, appointmentsApi: { ...actual.appointmentsApi, list: vi.fn() } };
});

vi.mock('../../api/telehealth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/telehealth')>();
  return { ...actual, telehealthApi: { ...actual.telehealthApi, waitingRoom: vi.fn() } };
});

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

const mine = videoAppointment(1, inHours(2));
const colleagues = videoAppointment(2, inHours(3), {
  title_label: 'Taylor Brooks & Morgan Brooks',
  clinician: { id: 2, name: 'Jordan Park, LMFT' },
  participants: [participant(11, 'Taylor Brooks'), participant(12, 'Morgan Brooks')],
});
const hidden = videoAppointment(3, inHours(4), {
  title_label: 'Busy',
  clinician: { id: 2, name: 'Jordan Park, LMFT' },
  participants: [],
  restricted: true,
});

function renderPage(person: { staff?: Partial<StaffMember>; capabilities: Capability[] }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={testSession(person)}>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <TelehealthPage />
          </MemoryRouter>
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(appointmentsApi.list).mockResolvedValue([mine, colleagues, hidden]);
  vi.mocked(telehealthApi.waitingRoom).mockResolvedValue([]);
});

describe('TelehealthPage', () => {
  it("shows a clinician their own sessions, and everyone's when they manage every calendar", async () => {
    const user = userEvent.setup();
    renderPage({ staff: { id: 1 }, capabilities: ['schedule_all', 'clinical_all'] });

    expect(await screen.findByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.queryByText('Taylor Brooks & Morgan Brooks')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Opens/ })).toBeInTheDocument();
    expect(telehealthApi.waitingRoom).toHaveBeenCalledWith(1);

    await user.click(screen.getByRole('tab', { name: 'Everyone' }));
    expect(screen.getByText('Taylor Brooks & Morgan Brooks')).toBeInTheDocument();
    expect(screen.getByText('Hosted by Jordan Park, LMFT')).toBeInTheDocument();
    expect(screen.getByText('2 clients')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join links (2)' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Opens/ })).toHaveLength(1);
    expect(screen.queryByText('Busy')).not.toBeInTheDocument();
    expect(telehealthApi.waitingRoom).not.toHaveBeenCalledWith(2);
  });

  it("lets a scheduler share everyone's links without starting sessions", async () => {
    renderPage({ staff: { id: 5, role: 'scheduler', is_clinician: false }, capabilities: ['view_all_clients', 'schedule_all'] });

    expect(await screen.findByText('Taylor Brooks & Morgan Brooks')).toBeInTheDocument();
    expect(screen.getByText('Hosted by Dana Lee, LCSW')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Opens|Start session/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Start session/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link for Alex Rivera' })).toBeInTheDocument();
    expect(telehealthApi.waitingRoom).not.toHaveBeenCalled();
  });
});
