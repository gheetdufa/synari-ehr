import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capability, StaffMember } from '../api/auth';
import { appointmentsApi, type Appointment } from '../api/appointments';
import { telehealthApi, type WaitingRoomEntry } from '../api/telehealth';
import { testSession, WithSession } from '../test/session';
import { ToastProvider } from '../ui/Toast';
import { participant, videoAppointment } from './appointment.fixture';
import SessionRoomPage from './SessionRoomPage';
import type { LocalPreview } from './video/useLocalPreview';

vi.mock('../api/appointments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/appointments')>();
  return { ...actual, appointmentsApi: { ...actual.appointmentsApi, get: vi.fn() } };
});

vi.mock('../api/telehealth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/telehealth')>();
  return {
    ...actual,
    telehealthApi: {
      ...actual.telehealthApi,
      hostToken: vi.fn(),
      waitingRoom: vi.fn(),
      recordingConsent: vi.fn(),
      joinLinks: vi.fn(),
      sendLinks: vi.fn(),
    },
  };
});

// The camera check needs real media devices; these screens don't.
const preview: LocalPreview = {
  choices: { audioEnabled: true, videoEnabled: true, audioDeviceId: '', videoDeviceId: '' },
  audioTrack: null,
  videoTrack: null,
  problems: { microphone: null, camera: null },
  pending: false,
  setAudioEnabled: vi.fn(),
  setVideoEnabled: vi.fn(),
  selectDevice: vi.fn(),
  retry: vi.fn(),
};
vi.mock('./video/useLocalPreview', () => ({
  useLocalPreview: () => preview,
  useAudioLevel: () => 0,
  useDeviceList: () => [],
}));

const couple = videoAppointment(42, '2026-10-05T14:00:00Z', {
  title_label: 'Alex Rivera & Sam Lee',
  participants: [participant(7, 'Alex Rivera'), participant(8, 'Sam Lee')],
});

function waiting(id: number, displayName: string, clientId: number): WaitingRoomEntry {
  return {
    id,
    display_name: displayName,
    status: 'waiting',
    recording_consent: true,
    current_location: '',
    client_id: clientId,
    created_at: new Date().toISOString(),
    admitted_at: null,
  };
}

type Person = { staff?: Partial<StaffMember>; capabilities: Capability[] };

const HOST: Person = { staff: { id: 1 }, capabilities: [] };
const SCHEDULER: Person = {
  staff: { id: 5, role: 'scheduler', is_clinician: false, display_name: 'Pat Kim' },
  capabilities: ['view_all_clients', 'schedule_all'],
};
const COLLEAGUE: Person = { staff: { id: 3, role: 'clinician', display_name: 'Jordan Park, LMFT' }, capabilities: [] };

function renderSession(person: Person, appointment: Appointment) {
  vi.mocked(appointmentsApi.get).mockResolvedValue(appointment);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={testSession(person)}>
          <MemoryRouter initialEntries={[`/session/${appointment.id}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route path="/session/:appointmentId" element={<SessionRoomPage />} />
            </Routes>
          </MemoryRouter>
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(telehealthApi.waitingRoom).mockResolvedValue([]);
  vi.mocked(telehealthApi.recordingConsent).mockResolvedValue({ recording_enabled: true, all_consented: false, participants: [] });
});

describe('SessionRoomPage for staff who can’t host', () => {
  it('names the host and offers only the join links to someone who manages the calendar', async () => {
    renderSession(SCHEDULER, couple);

    expect(await screen.findByRole('heading', { name: 'Alex Rivera & Sam Lee' })).toBeInTheDocument();
    expect(screen.getByText('Only Dana Lee, LCSW can host this session.')).toBeInTheDocument();
    const links = screen.getByRole('region', { name: 'Join links' });
    expect(within(links).getByRole('button', { name: 'Copy link for Alex Rivera' })).toBeInTheDocument();
    expect(within(links).getByRole('button', { name: 'Send link to Sam Lee' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join session/ })).not.toBeInTheDocument();
    expect(telehealthApi.hostToken).not.toHaveBeenCalled();
    expect(telehealthApi.waitingRoom).not.toHaveBeenCalled();
    expect(telehealthApi.recordingConsent).not.toHaveBeenCalled();
  });

  it("shows another clinician only who hosts it when they don't manage that calendar", async () => {
    renderSession(COLLEAGUE, couple);

    expect(await screen.findByText('Only Dana Lee, LCSW can host this session.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /link/i })).not.toBeInTheDocument();
    expect(telehealthApi.waitingRoom).not.toHaveBeenCalled();
  });

  it("won't open a colleague's session with clients out of reach", async () => {
    renderSession(COLLEAGUE, { ...couple, restricted: true, participants: [], title_label: 'Busy' });
    expect(await screen.findByRole('heading', { name: "You can't open this session" })).toBeInTheDocument();
  });
});

describe('SessionRoomPage for the host', () => {
  it("shows each client's status, who is waiting on whose link, and per-client link actions", async () => {
    vi.mocked(telehealthApi.waitingRoom).mockResolvedValue([waiting(90, 'Alex', 7)]);
    renderSession(HOST, couple);

    const clients = await screen.findByRole('region', { name: 'Clients (2)' });
    const [alex, sam] = within(clients).getAllByRole('listitem');
    expect(await within(alex).findByText('Waiting')).toBeInTheDocument();
    expect(within(sam).getByText('Not here yet')).toBeInTheDocument();
    expect(within(sam).getByRole('button', { name: 'Send link to Sam Lee' })).toBeInTheDocument();
    expect(screen.getByText("Alex Rivera's link")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Join session/ })).toBeInTheDocument();
    expect(telehealthApi.waitingRoom).toHaveBeenCalledWith(42);
  });
});
