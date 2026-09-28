import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalClient } from '../../api/auth';
import { portalEstimatesApi, type PortalEstimate, type PortalEstimates } from '../../api/estimates';
import { ToastProvider } from '../../ui/Toast';
import { PortalEstimatesSection } from './PortalEstimatesSection';

const CLIENT: PortalClient = {
  id: 3,
  first_name: 'Samantha',
  last_name: 'Park',
  preferred_name: 'Sam',
  email: 'sam@example.com',
  clinician_name: 'Dana Lee, LCSW',
  practice_name: 'Calm Harbor Therapy',
  time_zone: 'America/Chicago',
  permissions: { messaging: true, booking: true, billing: true },
  idle_timeout_minutes: 30,
  acting_contact: null,
};

vi.mock('../../auth/ClientAuth', () => ({ usePortalClient: () => CLIENT }));

function estimate(changes: Partial<PortalEstimate> = {}): PortalEstimate {
  return {
    id: 5,
    clinician_name: 'Dana Lee, LCSW',
    status: 'issued',
    period_start: '2026-10-01',
    period_end: '2027-09-30',
    primary_service: 'Individual psychotherapy',
    total_cents: 180000,
    issued_at: '2026-09-20T15:00:00Z',
    change_summary: '',
    acknowledged_at: null,
    acknowledged_name: '',
    ...changes,
  };
}

function listing(changes: Partial<PortalEstimates> = {}): PortalEstimates {
  return {
    enabled: true,
    estimates: [estimate(), estimate({ id: 2, status: 'superseded', total_cents: 150000, issued_at: '2026-03-01T15:00:00Z' })],
    clinicians: [
      { id: 1, name: 'Dana Lee, LCSW' },
      { id: 2, name: 'Jordan Kim, LPC' },
    ],
    request_pending: false,
    ...changes,
  };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PortalEstimatesSection />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('PortalEstimatesSection', () => {
  beforeEach(() => {
    vi.spyOn(portalEstimatesApi, 'list').mockResolvedValue(listing());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists every estimate the client was given, current and replaced', async () => {
    renderSection();
    const list = await screen.findByRole('list', { name: 'Your good faith estimates' });
    const [current, replaced] = within(list).getAllByRole('listitem');
    expect(within(current).getByText('Current')).toBeInTheDocument();
    expect(within(current).getByText('$1,800.00')).toBeInTheDocument();
    expect(within(current).getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(within(replaced).getByText('Replaced')).toBeInTheDocument();
    expect(within(replaced).queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(within(list).getAllByRole('button', { name: /Download the good faith estimate/ })).toHaveLength(2);
  });

  it('records an optional acknowledgment with the typed name', async () => {
    const user = userEvent.setup();
    const acknowledge = vi
      .spyOn(portalEstimatesApi, 'acknowledge')
      .mockResolvedValue(estimate({ acknowledged_at: '2026-09-26T15:00:00Z', acknowledged_name: 'Sam Park' }));
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));
    expect(screen.getByText('Type your full name.')).toBeInTheDocument();
    expect(acknowledge).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: 'Your full name' }), '  Sam Park ');
    await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith(5, 'Sam Park'));
  });

  it('asks for a cost estimate with the chosen clinician', async () => {
    const user = userEvent.setup();
    const request = vi.spyOn(portalEstimatesApi, 'request').mockResolvedValue({ detail: 'Request sent' });
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Request a cost estimate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request a cost estimate' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'For care with' }), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(2));
  });

  it('explains that a request is already with the practice', async () => {
    vi.spyOn(portalEstimatesApi, 'list').mockResolvedValue(listing({ request_pending: true }));
    renderSection();
    expect(await screen.findByRole('button', { name: 'Request a cost estimate' })).toBeDisabled();
    expect(screen.getByText('Calm Harbor Therapy is already preparing an estimate for you.')).toBeInTheDocument();
  });

  it('hides the request button when the practice has estimates turned off', async () => {
    vi.spyOn(portalEstimatesApi, 'list').mockResolvedValue(listing({ enabled: false }));
    renderSection();
    expect(await screen.findByRole('list', { name: 'Your good faith estimates' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request a cost estimate' })).not.toBeInTheDocument();
  });
});
