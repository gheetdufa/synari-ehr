import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BookingPageInfo, PublicBookingClinician, Slot } from '../api/booking';
import { addDaysToKey, dayKeyOf } from '../client/appointments/slots';
import BookingPage, { servicePrice } from './BookingPage';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };
const NY = 'America/New_York';

const mocks = vi.hoisted(() => ({ page: vi.fn(), slots: vi.fn(), request: vi.fn() }));

vi.mock('../api/booking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/booking')>()),
  publicBookingApi: { page: mocks.page, slots: mocks.slots, request: mocks.request },
}));

const JORDAN: PublicBookingClinician = {
  id: 8,
  name: 'Jordan Lee, LCSW',
  time_zone: NY,
  services: [
    { id: 3, description: 'Individual therapy', duration_minutes: 50, rate_cents: 15000 },
    { id: 4, description: 'Intake assessment', duration_minutes: 60, rate_cents: 20000 },
  ],
};

const MAYA: PublicBookingClinician = {
  id: 9,
  name: 'Maya Chen, PhD',
  time_zone: NY,
  services: [{ id: 3, description: 'Individual therapy', duration_minutes: 50, rate_cents: 18000 }],
};

function pageInfo(clinicians: PublicBookingClinician[]): BookingPageInfo {
  return {
    practice_name: 'Calm Harbor Therapy',
    intro: '',
    time_zone: NY,
    clinicians,
    locations: [{ id: 5, name: 'Main office', address: '1 Main St, Springfield' }],
    gfe_notice: true,
  };
}

/** Tomorrow at 10:00 AM New York time (EDT or EST, whichever applies). */
function tomorrowSlot(): Slot {
  const day = addDaysToKey(dayKeyOf(new Date(), NY), 1);
  for (const offset of [4, 5]) {
    const starts = new Date(`${day}T${String(10 + offset).padStart(2, '0')}:00:00Z`);
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', hourCycle: 'h23' }).format(starts);
    if (Number(hour) === 10) {
      return {
        starts_at: starts.toISOString(),
        ends_at: new Date(starts.getTime() + 50 * 60_000).toISOString(),
        location_type: 'in_person',
        location_id: 5,
      };
    }
  }
  throw new Error('no slot');
}

function renderPage(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
        <Routes>
          <Route path="/book/:slug" element={<BookingPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.slots.mockResolvedValue([tomorrowSlot()]);
  mocks.request.mockResolvedValue({ status: 'requested' });
});

describe('BookingPage', () => {
  it('starts with a choice of clinicians, then shows the chosen one’s services and rates', async () => {
    const user = userEvent.setup();
    mocks.page.mockResolvedValue(pageInfo([JORDAN, MAYA]));
    renderPage('/book/calm-harbor');

    expect(await screen.findByRole('heading', { name: 'Choose a clinician' })).toBeInTheDocument();
    expect(mocks.page).toHaveBeenCalledWith('calm-harbor', undefined);
    const jordan = screen.getByRole('button', { name: /Jordan Lee, LCSW/ });
    expect(jordan).toHaveTextContent('Individual therapy ($150.00) · Intake assessment ($200.00)');
    expect(screen.getByRole('button', { name: /Maya Chen, PhD/ })).toHaveTextContent('Individual therapy ($180.00)');
    await waitFor(() => expect(jordan).toHaveTextContent(/Next opening: .+, 10:00\sAM/));
    // Each card checks the clinician's shortest service over the coming week.
    expect(mocks.slots).toHaveBeenCalledWith('calm-harbor', expect.objectContaining({ clinician_id: 8, service_id: 3 }));

    await user.click(jordan);
    expect(await screen.findByRole('heading', { name: 'Choose a service' })).toBeInTheDocument();
    expect(screen.getByText('With Jordan Lee, LCSW')).toBeInTheDocument();
    const services = within(screen.getByRole('list', { name: 'Services' }));
    expect(services.getByRole('button', { name: /Individual therapy/ })).toHaveTextContent('$150.00');
    expect(services.getByRole('button', { name: /Intake assessment/ })).toHaveTextContent('$200.00');
  });

  it('books with the linked clinician and sends their id with the request', async () => {
    const user = userEvent.setup();
    mocks.page.mockResolvedValue(pageInfo([JORDAN]));
    renderPage('/book/calm-harbor?clinician_id=8');

    expect(await screen.findByRole('heading', { name: 'Choose a service' })).toBeInTheDocument();
    expect(mocks.page).toHaveBeenCalledWith('calm-harbor', 8);
    expect(screen.getByText('with Jordan Lee, LCSW')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all clinicians' })).toHaveAttribute('href', '/book/calm-harbor');
    expect(screen.queryByText('Choose a clinician')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Individual therapy/ }));
    const time = await screen.findByRole('button', { name: /10:00\sAM/ });
    expect(time).toHaveTextContent('In person · Main office');
    expect(mocks.slots).toHaveBeenLastCalledWith('calm-harbor', expect.objectContaining({ clinician_id: 8, service_id: 3 }));
    await user.click(time);

    expect(await screen.findByRole('heading', { name: 'Your details' })).toBeInTheDocument();
    expect(screen.getByText('Jordan Lee, LCSW')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/First name/), 'Riley');
    await user.type(screen.getByLabelText(/Last name/), 'Park');
    fireEvent.change(screen.getByLabelText(/Date of birth/), { target: { value: '1990-05-01' } });
    await user.type(screen.getByLabelText(/^Email/), 'riley@example.com');
    await user.type(screen.getByLabelText(/^Phone/), '555-123-4567');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByRole('heading', { name: 'Request sent' })).toBeInTheDocument();
    expect(mocks.request).toHaveBeenCalledWith(
      'calm-harbor',
      expect.objectContaining({
        clinician_id: 8,
        service_id: 3,
        starts_at: tomorrowSlot().starts_at,
        location_type: 'in_person',
        first_name: 'Riley',
        email: 'riley@example.com',
      }),
    );
  });

  it('explains when the linked clinician isn’t taking online requests', async () => {
    mocks.page.mockResolvedValue(pageInfo([]));
    renderPage('/book/calm-harbor?clinician_id=99');

    expect(await screen.findByText("This clinician isn't taking online requests")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all clinicians' })).toHaveAttribute('href', '/book/calm-harbor');
  });

  it('tells self-pay clients about their right to a Good Faith Estimate', async () => {
    const user = userEvent.setup();
    mocks.page.mockResolvedValue(pageInfo([JORDAN]));
    renderPage('/book/calm-harbor');

    const summary = await screen.findByText('Your right to a Good Faith Estimate');
    await user.click(summary);
    expect(screen.getByText(/at least \$400 more than your Good Faith Estimate/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'www.cms.gov/nosurprises' })).toHaveAttribute('href', 'https://www.cms.gov/nosurprises');
    expect(screen.getByRole('link', { name: '1-800-985-3059' })).toHaveAttribute('href', 'tel:18009853059');
  });

  it('leaves the notice off when the practice has estimates turned off', async () => {
    mocks.page.mockResolvedValue({ ...pageInfo([JORDAN]), gfe_notice: false });
    renderPage('/book/calm-harbor');

    expect(await screen.findByRole('heading', { name: 'Choose a service' })).toBeInTheDocument();
    expect(screen.queryByText('Your right to a Good Faith Estimate')).not.toBeInTheDocument();
  });
});

describe('servicePrice', () => {
  it('says free for services without a charge', () => {
    expect(servicePrice(0)).toBe('free');
    expect(servicePrice(15000)).toBe('$150.00');
  });
});
