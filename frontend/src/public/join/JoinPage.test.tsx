import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { EnterResult, EntryStatus, JoinInfo } from '../../api/telehealth';
import type { LocalPreview } from '../../telehealth/video/useLocalPreview';
import JoinPage from '../JoinPage';

const guestApi = vi.hoisted(() => ({
  joinInfo: vi.fn<(token: string) => Promise<JoinInfo>>(),
  enter: vi.fn<(token: string, input: unknown) => Promise<EnterResult>>(),
  poll: vi.fn<() => Promise<EntryStatus>>(),
  leave: vi.fn<() => Promise<EntryStatus>>(),
  leaveOnUnload: vi.fn(),
}));

vi.mock('../../api/telehealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/telehealth')>()),
  guestApi,
}));

// The camera preview needs real media devices; the form doesn't.
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
vi.mock('../../telehealth/video/useLocalPreview', () => ({
  useLocalPreview: () => preview,
  useAudioLevel: () => 0,
  useDeviceList: () => [],
}));

const TOKEN = 'join-token';

function joinInfo(changes: Partial<JoinInfo> = {}): JoinInfo {
  return {
    status: 'open',
    starts_at: '2026-10-05T14:00:00Z',
    ends_at: '2026-10-05T14:50:00Z',
    clinician_name: 'Dr. Maya Chen',
    practice_name: 'Harbor Counseling',
    time_zone: 'America/Los_Angeles',
    waiting_room_enabled: true,
    recording_enabled: true,
    ...changes,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/join/${TOKEN}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/join/:token" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  guestApi.poll.mockReturnValue(new Promise<EntryStatus>(() => undefined));
});

describe('guest join form', () => {
  it('asks for a name, an optional location and recording consent', async () => {
    guestApi.joinInfo.mockResolvedValue(joinInfo());
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Video appointment with Dr. Maya Chen' })).toBeInTheDocument();
    // 14:00 UTC shown in the client's zone (Pacific), with the zone named.
    expect(screen.getByText('Monday, October 5 at 7:00 AM PDT')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your name/)).toHaveValue('');
    expect(screen.getByLabelText('Where are you right now? (optional)')).toBeInTheDocument();
    expect(screen.getByText(/only used if there's an emergency/i)).toBeInTheDocument();
    const consent = screen.getByRole('checkbox', { name: /I agree to this session's audio being recorded/ });
    expect(consent).not.toBeChecked();
    expect(screen.getByText(/deleted once the note is signed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter waiting room' })).toBeInTheDocument();
  });

  it('requires a name before checking in', async () => {
    guestApi.joinInfo.mockResolvedValue(joinInfo());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Enter waiting room' }));
    expect(screen.getByText('Please enter your name.')).toBeInTheDocument();
    expect(guestApi.enter).not.toHaveBeenCalled();
  });

  it('checks in with the details given and shows the waiting room', async () => {
    guestApi.joinInfo.mockResolvedValue(joinInfo());
    guestApi.enter.mockResolvedValue({ entry_id: 12, secret: 'abc', status: 'waiting' });
    renderPage();

    await userEvent.type(await screen.findByLabelText(/Your name/), '  Alex Rivera ');
    await userEvent.type(screen.getByLabelText('Where are you right now? (optional)'), 'Home, 12 Elm St');
    await userEvent.click(screen.getByRole('checkbox', { name: /I agree to this session's audio being recorded/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Enter waiting room' }));

    expect(guestApi.enter).toHaveBeenCalledWith(TOKEN, {
      display_name: 'Alex Rivera',
      current_location: 'Home, 12 Elm St',
      recording_consent: true,
    });
    expect(await screen.findByRole('heading', { name: "You're in the waiting room" })).toBeInTheDocument();
    expect(screen.getByText('Dr. Maya Chen will let you in shortly.')).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(`synari.join.${TOKEN}`) ?? '{}')).toMatchObject({ entryId: 12, secret: 'abc' });
  });

  it('hides the consent question when the practice does not record', async () => {
    guestApi.joinInfo.mockResolvedValue(joinInfo({ recording_enabled: false, waiting_room_enabled: false }));
    guestApi.enter.mockResolvedValue({ entry_id: 3, secret: 'x', status: 'admitted' });
    renderPage();

    await userEvent.type(await screen.findByLabelText(/Your name/), 'Sam');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Join session' }));
    expect(guestApi.enter).toHaveBeenCalledWith(TOKEN, { display_name: 'Sam', current_location: '', recording_consent: false });
  });

  it('shows the server message when checking in is refused', async () => {
    guestApi.joinInfo.mockResolvedValue(joinInfo());
    guestApi.enter.mockRejectedValue(new ApiError(409, 'This appointment has ended.'));
    renderPage();

    await userEvent.type(await screen.findByLabelText(/Your name/), 'Alex');
    await userEvent.click(screen.getByRole('button', { name: 'Enter waiting room' }));
    expect(await screen.findByText('This appointment has ended.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your name/)).toHaveValue('Alex');
  });
});

describe('join link states', () => {
  it('asks early guests to come back 60 minutes before', async () => {
    guestApi.joinInfo.mockResolvedValue(joinInfo({ status: 'too_early' }));
    renderPage();
    expect(await screen.findByRole('heading', { name: "It's a little early" })).toBeInTheDocument();
    expect(screen.getByText(/Come back 60 minutes before it starts \(from Monday, October 5 at 6:00 AM PDT\)/)).toBeInTheDocument();
  });

  it('explains an invalid link', async () => {
    guestApi.joinInfo.mockRejectedValue(new ApiError(404, "This video link isn't valid or has expired."));
    renderPage();
    expect(await screen.findByRole('heading', { name: "This link isn't valid" })).toBeInTheDocument();
  });

  it.each([
    ['canceled', 'This appointment was canceled'],
    ['ended', 'This appointment has ended'],
  ] as const)('shows when the appointment is %s', async (status, heading) => {
    guestApi.joinInfo.mockResolvedValue(joinInfo({ status }));
    renderPage();
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });
});
