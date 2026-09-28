import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PortalClient } from '../../api/auth';
import {
  portalRecordsApi,
  type DisclosureAccounting,
  type PortalAmendmentRequest,
  type PortalRecordRequest,
} from '../../api/portalRecords';
import { ToastProvider } from '../../ui/Toast';
import ClientRecordsPage from './ClientRecordsPage';

const mocks = vi.hoisted(() => ({ client: null as PortalClient | null }));

vi.mock('../../auth/ClientAuth', () => ({ usePortalClient: () => mocks.client }));
vi.mock('../../api/portalRecords', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/portalRecords')>();
  return {
    ...actual,
    portalRecordsApi: {
      recordRequests: vi.fn(),
      requestRecord: vi.fn(),
      downloadRelease: vi.fn(),
      disclosures: vi.fn(),
      downloadDisclosuresPdf: vi.fn(),
      amendmentRequests: vi.fn(),
      requestAmendment: vi.fn(),
      disagree: vi.fn(),
    },
  };
});

const alex: PortalClient = {
  id: 7,
  first_name: 'Alex',
  last_name: 'Rivera',
  preferred_name: '',
  email: 'alex@example.com',
  clinician_name: 'Dana Lee, LCSW',
  practice_name: 'Harbor Counseling',
  time_zone: 'America/Chicago',
  permissions: { messaging: true, booking: true, billing: true },
  idle_timeout_minutes: 30,
  acting_contact: null,
};

function recordRequest(id: number, changes: Partial<PortalRecordRequest> = {}): PortalRecordRequest {
  return {
    id,
    received_at: '2026-09-01T15:00:00Z',
    due_on: '2026-10-01',
    extended_on: null,
    extension_reason: '',
    scope: `Request ${id}`,
    delivery: 'portal',
    recipient: '',
    status: 'open',
    fulfilled_at: null,
    denial_reason: '',
    release_available: false,
    release_expires_at: null,
    ...changes,
  };
}

function amendment(id: number, changes: Partial<PortalAmendmentRequest> = {}): PortalAmendmentRequest {
  return {
    id,
    received_at: '2026-09-01T15:00:00Z',
    due_on: '2026-10-31',
    request: `Change ${id}`,
    status: 'open',
    decided_at: null,
    denial_reason: '',
    disagreement: '',
    rebuttal: '',
    can_disagree: false,
    ...changes,
  };
}

function accounting(disclosures: DisclosureAccounting['disclosures'] = []): DisclosureAccounting {
  return {
    client_id: 7,
    client_name: 'Alex Rivera',
    practice_name: 'Harbor Counseling',
    period_start: '2020-09-26',
    period_end: '2026-09-26',
    generated_at: '2026-09-26T12:00:00Z',
    disclosures,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <ClientRecordsPage />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function requestSection() {
  return screen.getByRole('heading', { name: 'Request a copy of my record' }).closest('div.rounded-xl') as HTMLElement;
}

function amendmentSection() {
  return screen.getByRole('heading', { name: 'Request a change to my record' }).closest('div.rounded-xl') as HTMLElement;
}

describe('ClientRecordsPage', () => {
  beforeEach(() => {
    mocks.client = alex;
    vi.mocked(portalRecordsApi.recordRequests).mockResolvedValue([]);
    vi.mocked(portalRecordsApi.disclosures).mockResolvedValue(accounting());
    vi.mocked(portalRecordsApi.amendmentRequests).mockResolvedValue([]);
  });

  afterEach(() => vi.clearAllMocks());

  describe('requesting a copy', () => {
    it('sends a portal request with what the client asked for', async () => {
      const user = userEvent.setup();
      vi.mocked(portalRecordsApi.requestRecord).mockResolvedValue(recordRequest(1, { due_on: '2026-10-26' }));
      renderPage();
      const section = requestSection();

      await user.type(within(section).getByLabelText(/what would you like a copy of/i), '  My complete record  ');
      await user.click(within(section).getByRole('button', { name: 'Request a copy' }));

      await waitFor(() =>
        expect(portalRecordsApi.requestRecord).toHaveBeenCalledWith({ scope: 'My complete record', delivery: 'portal' }),
      );
      expect(await screen.findByText('Request sent. The practice will respond by Oct 26, 2026.')).toBeInTheDocument();
    });

    it('requires what to copy', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(within(requestSection()).getByRole('button', { name: 'Request a copy' }));
      expect(screen.getByText('Tell us what you’d like a copy of')).toBeInTheDocument();
      expect(portalRecordsApi.requestRecord).not.toHaveBeenCalled();
    });

    it('asks who to send it to for third-party delivery', async () => {
      const user = userEvent.setup();
      vi.mocked(portalRecordsApi.requestRecord).mockResolvedValue(recordRequest(2, { delivery: 'third_party' }));
      renderPage();
      const section = requestSection();

      expect(within(section).queryByLabelText(/who should we send it to/i)).not.toBeInTheDocument();
      await user.type(within(section).getByLabelText(/what would you like a copy of/i), 'Notes from 2025');
      await user.click(within(section).getByRole('radio', { name: /send it to someone else/i }));
      await user.click(within(section).getByRole('button', { name: 'Request a copy' }));

      expect(within(section).getByText('Tell us who to send it to and where')).toBeInTheDocument();
      expect(portalRecordsApi.requestRecord).not.toHaveBeenCalled();

      await user.type(within(section).getByLabelText(/who should we send it to/i), 'Dr. Kim, 12 Main St, Springfield');
      await user.click(within(section).getByRole('button', { name: 'Request a copy' }));

      await waitFor(() =>
        expect(portalRecordsApi.requestRecord).toHaveBeenCalledWith({
          scope: 'Notes from 2025',
          delivery: 'third_party',
          recipient: 'Dr. Kim, 12 Main St, Springfield',
        }),
      );
    });

    it('lists requests by status with a download only for available releases', async () => {
      const user = userEvent.setup();
      vi.mocked(portalRecordsApi.recordRequests).mockResolvedValue([
        recordRequest(1, { scope: 'Open one' }),
        recordRequest(2, {
          scope: 'Extended one',
          extended_on: '2026-09-20',
          due_on: '2026-10-31',
          extension_reason: 'Records are in off-site storage',
        }),
        recordRequest(3, {
          scope: 'Ready one',
          status: 'fulfilled',
          fulfilled_at: '2026-09-10T15:00:00Z',
          release_available: true,
          release_expires_at: '2026-10-10T15:00:00Z',
        }),
        recordRequest(4, {
          scope: 'Old one',
          status: 'fulfilled',
          fulfilled_at: '2026-06-10T15:00:00Z',
          release_expires_at: '2026-07-10T15:00:00Z',
        }),
        recordRequest(5, { scope: 'Denied one', status: 'denied', denial_reason: 'Not our record' }),
        recordRequest(6, {
          scope: 'Sent one',
          status: 'fulfilled',
          delivery: 'third_party',
          recipient: 'Dr. Kim',
          fulfilled_at: '2026-09-12T15:00:00Z',
        }),
      ]);
      vi.mocked(portalRecordsApi.downloadRelease).mockResolvedValue(undefined);
      renderPage();

      const list = await screen.findByRole('list', { name: 'Your record requests' });
      const rows = within(list).getAllByRole('listitem');
      expect(rows).toHaveLength(6);

      expect(within(rows[0]).getByText('In progress')).toBeInTheDocument();
      expect(within(rows[0]).getByText('The practice will respond by Oct 1, 2026.')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Extended')).toBeInTheDocument();
      expect(within(rows[1]).getByText(/respond by Oct 31, 2026\. Reason: Records are in off-site storage/)).toBeInTheDocument();
      expect(within(rows[2]).getByText('Ready to download')).toBeInTheDocument();
      expect(within(rows[2]).getByText('Available until Oct 10, 2026.')).toBeInTheDocument();
      expect(within(rows[3]).getByText('Expired')).toBeInTheDocument();
      expect(within(rows[4]).getByText('Denied')).toBeInTheDocument();
      expect(within(rows[4]).getByText('Reason: Not our record')).toBeInTheDocument();
      expect(within(rows[5]).getByText('Sent')).toBeInTheDocument();
      expect(within(rows[5]).getByText('To: Dr. Kim')).toBeInTheDocument();

      expect(within(list).getAllByRole('button', { name: 'Download' })).toHaveLength(1);
      await user.click(within(rows[2]).getByRole('button', { name: 'Download' }));
      expect(portalRecordsApi.downloadRelease).toHaveBeenCalledWith(3);
    });
  });

  describe('accounting of disclosures', () => {
    it('explains when nothing was disclosed', async () => {
      renderPage();
      expect(await screen.findByText('Nothing to report')).toBeInTheDocument();
    });

    it('lists disclosures and downloads the PDF', async () => {
      const user = userEvent.setup();
      vi.mocked(portalRecordsApi.disclosures).mockResolvedValue(
        accounting([
          {
            id: 4,
            disclosed_on: '2026-03-02',
            recipient_name: 'County Court',
            recipient_address: '1 Court Sq',
            description: 'Treatment dates',
            purpose: 'Subpoena response',
            legal_basis: 'court order',
          },
        ]),
      );
      vi.mocked(portalRecordsApi.downloadDisclosuresPdf).mockResolvedValue(undefined);
      renderPage();

      const list = await screen.findByRole('list', { name: 'Disclosures' });
      expect(within(list).getByText('County Court')).toBeInTheDocument();
      expect(within(list).getByText('Mar 2, 2026')).toBeInTheDocument();
      expect(within(list).getByText('Subpoena response')).toBeInTheDocument();
      expect(within(list).getByText('Treatment dates')).toBeInTheDocument();
      expect(within(list).getByText('court order')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Download PDF' }));
      expect(portalRecordsApi.downloadDisclosuresPdf).toHaveBeenCalled();
    });
  });

  describe('amendments', () => {
    it('sends a change request', async () => {
      const user = userEvent.setup();
      vi.mocked(portalRecordsApi.requestAmendment).mockResolvedValue(amendment(9, { due_on: '2026-11-25' }));
      renderPage();
      const section = amendmentSection();

      await user.click(within(section).getByRole('button', { name: 'Request a change' }));
      expect(within(section).getByText('Tell us what should be changed and why')).toBeInTheDocument();

      await user.type(within(section).getByLabelText(/what should be changed/i), 'My birth date is wrong');
      await user.click(within(section).getByRole('button', { name: 'Request a change' }));

      await waitFor(() => expect(portalRecordsApi.requestAmendment).toHaveBeenCalledWith('My birth date is wrong'));
      expect(await screen.findByText('Request sent. The practice will decide by Nov 25, 2026.')).toBeInTheDocument();
    });

    it('offers a statement of disagreement only on denials without one', async () => {
      const user = userEvent.setup();
      vi.mocked(portalRecordsApi.amendmentRequests).mockResolvedValue([
        amendment(1, { request: 'Open request' }),
        amendment(2, { request: 'Accepted request', status: 'accepted', decided_at: '2026-09-10T15:00:00Z' }),
        amendment(3, { request: 'Denied request', status: 'denied', denial_reason: 'The note is accurate', can_disagree: true }),
        amendment(4, {
          request: 'Disputed request',
          status: 'denied',
          denial_reason: 'Accurate as written',
          disagreement: 'I still disagree',
          rebuttal: 'We stand by the note',
        }),
      ]);
      vi.mocked(portalRecordsApi.disagree).mockResolvedValue(
        amendment(3, { status: 'denied', disagreement: 'It is not accurate', can_disagree: false }),
      );
      renderPage();

      const list = await screen.findByRole('list', { name: 'Your change requests' });
      const rows = within(list).getAllByRole('listitem');
      expect(within(rows[0]).getByText('Under review')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Accepted')).toBeInTheDocument();
      expect(within(rows[2]).getByText('Reason: The note is accurate')).toBeInTheDocument();
      expect(within(rows[3]).getByText('I still disagree')).toBeInTheDocument();
      expect(within(rows[3]).getByText('We stand by the note')).toBeInTheDocument();

      const offers = within(list).getAllByRole('button', { name: 'Submit a statement of disagreement' });
      expect(offers).toHaveLength(1);
      expect(within(rows[2]).getByRole('button', { name: 'Submit a statement of disagreement' })).toBeInTheDocument();

      await user.click(offers[0]);
      await user.type(within(rows[2]).getByLabelText(/statement of disagreement/i), 'It is not accurate');
      await user.click(within(rows[2]).getByRole('button', { name: 'Submit statement' }));

      await waitFor(() => expect(portalRecordsApi.disagree).toHaveBeenCalledWith(3, 'It is not accurate'));
      expect(await screen.findByText('Your statement was added to your record.')).toBeInTheDocument();
    });
  });

  it("names the client when a guardian is signed in", () => {
    mocks.client = { ...alex, acting_contact: { id: 31, name: 'Pat Rivera' } };
    renderPage();
    expect(
      screen.getByText('Ask for a copy of Alex’s record, see who the practice shared it with, or ask for a correction.'),
    ).toBeInTheDocument();
  });
});
