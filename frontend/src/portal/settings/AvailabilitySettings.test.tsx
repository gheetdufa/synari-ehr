import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/auth';
import type { AvailabilityBlockInput } from '../../api/availability';
import type { Location } from '../../api/practice';
import type { TeamMember } from '../../api/team';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { AvailabilitySettings } from './AvailabilitySettings';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const mocks = vi.hoisted(() => ({ get: vi.fn(), replace: vi.fn(), team: vi.fn() }));

vi.mock('../../api/availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/availability')>();
  return { ...actual, availabilityApi: { get: mocks.get, replace: mocks.replace } };
});
vi.mock('../../api/practice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/practice')>()),
  practiceApi: {
    settings: () => Promise.resolve({ booking_enabled: true }),
    locations: () => Promise.resolve(LOCATIONS),
  },
}));
vi.mock('../../api/team', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/team')>()),
  teamApi: { list: mocks.team },
}));

function location(id: number, name: string, isVideo: boolean): Location {
  return {
    id,
    name,
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    postal_code: '',
    place_of_service: isVideo ? '10' : '11',
    is_video: isVideo,
    is_active: true,
  };
}

const LOCATIONS = [location(11, 'Main office', false), location(12, 'Video office', true)];

function member(id: number, name: string, overrides: Partial<TeamMember> = {}): TeamMember {
  const [first, last] = name.split(' ');
  return {
    id,
    email: `${first.toLowerCase()}@example.com`,
    first_name: first,
    last_name: last,
    display_name: name,
    status: 'active',
    role: 'clinician',
    clinician_access: 'basic',
    is_clinician: true,
    supervisor_id: null,
    credentials: '',
    license_number: '',
    license_state: '',
    npi: '',
    taxonomy_code: '',
    claim_modifier: '',
    accepting_new_clients: true,
    invited_at: null,
    last_login_at: null,
    mfa_enabled: false,
    ...overrides,
  };
}

const TEAM = [
  member(1, 'Dana Lee', { role: 'owner' }),
  member(2, 'Jordan Park'),
  member(3, 'Sky Chen', { role: 'scheduler', is_clinician: false }),
];

function renderEditor(session: Session = testSession({ staff: { time_zone: 'America/Chicago' } })) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter future={ROUTER_FUTURE}>
            <AvailabilitySettings />
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('AvailabilitySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.team.mockResolvedValue(TEAM);
    mocks.get.mockImplementation((clinicianId: number) =>
      Promise.resolve(
        clinicianId === 1
          ? [{ id: 1, clinician_id: 1, weekday: 0, start_time: '09:00', end_time: '12:00', location_type: 'video', location_id: 12 }]
          : [],
      ),
    );
    mocks.replace.mockImplementation((clinicianId: number, blocks: AvailabilityBlockInput[]) =>
      Promise.resolve(blocks.map((block, index) => ({ ...block, id: index + 10, clinician_id: clinicianId }))),
    );
  });

  it('blocks saving overlapping ranges, then replaces the whole week with each range’s office', async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(await screen.findByLabelText('Monday range 1 start')).toHaveValue('09:00');
    expect(mocks.get).toHaveBeenCalledWith(1);
    expect(screen.getByText('All changes saved')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Add hours' })[0]);
    expect(screen.getByLabelText('Monday range 2 start')).toHaveValue('12:00');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Monday range 2 start'), { target: { value: '11:00' } });
    expect(screen.getByText('Overlaps another time range on this day')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Fix the highlighted times before saving.')).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Monday range 2 start'), { target: { value: '13:00' } });
    fireEvent.change(screen.getByLabelText('Monday range 2 end'), { target: { value: '15:00' } });
    await user.selectOptions(screen.getByLabelText('Monday range 2 location'), 'In person · Main office');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith(1, [
        { weekday: 0, start_time: '09:00', end_time: '12:00', location_type: 'video', location_id: 12 },
        { weekday: 0, start_time: '13:00', end_time: '15:00', location_type: 'in_person', location_id: 11 },
      ]),
    );
    expect(await screen.findByText('Availability saved')).toBeInTheDocument();
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });

  it('lets a scheduler set any clinician’s hours, one clinician at a time', async () => {
    const user = userEvent.setup();
    renderEditor(
      testSession({
        staff: { id: 3, is_clinician: false, role: 'scheduler' },
        capabilities: ['view_all_clients', 'schedule_all'],
      }),
    );

    const picker = await screen.findByLabelText('Clinician');
    expect(picker).toHaveValue('1');
    expect(screen.getByRole('option', { name: 'Jordan Park' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Sky Chen/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Times are in Dana Lee's time zone/)).toBeInTheDocument();

    await user.selectOptions(picker, '2');
    expect(await screen.findByText('No hours set. Add hours to the days clients can book.')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenLastCalledWith(2);

    await user.click(screen.getAllByRole('button', { name: 'Add hours' })[1]);
    expect(screen.getByLabelText('Clinician')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith(2, [
        { weekday: 1, start_time: '09:00', end_time: '17:00', location_type: 'video', location_id: 12 },
      ]),
    );
    expect(await screen.findByText('Availability saved for Jordan Park')).toBeInTheDocument();
  });

  it('shows clinicians only their own hours', async () => {
    renderEditor(testSession({ staff: { id: 2, role: 'clinician' }, capabilities: [] }));
    expect(await screen.findByText('No hours set. Add hours to the days clients can book.')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(2);
    expect(screen.queryByLabelText('Clinician')).not.toBeInTheDocument();
  });
});
