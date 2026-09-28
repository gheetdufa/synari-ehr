import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appointment } from '../api/appointments';
import { telehealthApi, type ParticipantLink } from '../api/telehealth';
import { ToastProvider } from '../ui/Toast';
import { participant, videoAppointment } from './appointment.fixture';
import { describeSentLinks, JoinLinkActions } from './JoinLinkActions';

vi.mock('../api/telehealth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/telehealth')>();
  return { ...actual, telehealthApi: { ...actual.telehealthApi, joinLinks: vi.fn(), sendLinks: vi.fn() } };
});

const ALEX: ParticipantLink = {
  client: { id: 7, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' },
  url: 'https://app.example.com/join/alex-token',
};
const SAM: ParticipantLink = {
  client: { id: 8, first_name: 'Sam', last_name: 'Lee', preferred_name: '' },
  url: 'https://app.example.com/join/sam-token',
};

const couple = videoAppointment(42, '2026-10-05T14:00:00Z', {
  title_label: 'Alex Rivera & Sam Lee',
  participants: [participant(7, 'Alex Rivera'), participant(8, 'Sam Lee')],
});

function renderActions(appointment: Appointment) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <JoinLinkActions appointment={appointment} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(telehealthApi.joinLinks).mockReset();
  vi.mocked(telehealthApi.sendLinks).mockReset();
});

describe('describeSentLinks', () => {
  const names: Record<number, string> = { 7: 'Alex Rivera', 8: 'Sam Lee', 9: 'Jo Park' };
  const nameOf = (id: number) => names[id];

  it.each([
    [[{ client_id: 7, email_sent: true, sms_sent: true }], 'Join link emailed and texted to Alex Rivera.'],
    [[{ client_id: 7, email_sent: true, sms_sent: false }], 'Join link emailed to Alex Rivera.'],
    [[{ client_id: 7, email_sent: false, sms_sent: true }], 'Join link texted to Alex Rivera.'],
    [
      [
        { client_id: 7, email_sent: true, sms_sent: false },
        { client_id: 8, email_sent: false, sms_sent: true },
      ],
      'Join links sent to 2 clients.',
    ],
    [
      [
        { client_id: 7, email_sent: true, sms_sent: false },
        { client_id: 8, email_sent: false, sms_sent: false },
      ],
      'Join link emailed to Alex Rivera. Sam Lee has no email address or text-message consent.',
    ],
    [
      [
        { client_id: 7, email_sent: true, sms_sent: false },
        { client_id: 8, email_sent: false, sms_sent: false },
        { client_id: 9, email_sent: false, sms_sent: false },
      ],
      'Join link emailed to Alex Rivera. Sam Lee and Jo Park have no email address or text-message consent.',
    ],
  ])('describes %j', (results, message) => {
    expect(describeSentLinks(results, nameOf)).toBe(message);
  });
});

describe('JoinLinkActions', () => {
  it("copies and sends a one-client session's link directly", async () => {
    const user = userEvent.setup();
    vi.mocked(telehealthApi.joinLinks).mockResolvedValue([ALEX]);
    vi.mocked(telehealthApi.sendLinks).mockResolvedValue([{ client_id: 7, email_sent: true, sms_sent: false }]);
    renderActions(videoAppointment(41, '2026-10-05T14:00:00Z'));

    await user.click(screen.getByRole('button', { name: 'Copy link for Alex Rivera' }));
    expect(await screen.findByText(/Alex Rivera's join link copied/)).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(ALEX.url);
    expect(telehealthApi.joinLinks).toHaveBeenCalledWith(41);

    await user.click(screen.getByRole('button', { name: 'Send link to Alex Rivera' }));
    expect(telehealthApi.sendLinks).toHaveBeenCalledWith(41, 7);
    expect(await screen.findByText('Join link emailed to Alex Rivera.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join links/ })).not.toBeInTheDocument();
  });

  it('shows the link to copy by hand when the clipboard is blocked', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('blocked'));
    vi.mocked(telehealthApi.joinLinks).mockResolvedValue([ALEX]);
    renderActions(videoAppointment(41, '2026-10-05T14:00:00Z'));

    await user.click(screen.getByRole('button', { name: 'Copy link for Alex Rivera' }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy the join link' });
    expect(within(dialog).getByLabelText("Alex Rivera's join link")).toHaveValue(ALEX.url);
  });

  it("lists each client's own link in a several-client session", async () => {
    const user = userEvent.setup();
    vi.mocked(telehealthApi.joinLinks).mockResolvedValue([ALEX, SAM]);
    vi.mocked(telehealthApi.sendLinks).mockImplementation(async (_id, clientId) =>
      clientId === undefined
        ? [
            { client_id: 7, email_sent: true, sms_sent: false },
            { client_id: 8, email_sent: true, sms_sent: true },
          ]
        : [{ client_id: clientId, email_sent: false, sms_sent: true }],
    );
    renderActions(couple);

    await user.click(screen.getByRole('button', { name: 'Join links (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Join links' });
    const list = await within(dialog).findByRole('list', { name: "Clients' join links" });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Alex Rivera'),
      expect.stringContaining('Sam Lee'),
    ]);

    await user.click(within(dialog).getByRole('button', { name: "Copy Sam Lee's link" }));
    expect(await navigator.clipboard.readText()).toBe(SAM.url);
    expect(await screen.findByText(/Sam Lee's join link copied/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: "Send Sam Lee's link" }));
    expect(telehealthApi.sendLinks).toHaveBeenLastCalledWith(42, 8);
    expect(await screen.findByText('Join link texted to Sam Lee.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Send to everyone' }));
    expect(telehealthApi.sendLinks).toHaveBeenLastCalledWith(42, undefined);
    expect(await screen.findByText('Join links sent to 2 clients.')).toBeInTheDocument();
  });

  it('offers nothing for a session without clients', () => {
    renderActions(videoAppointment(43, '2026-10-05T14:00:00Z', { participants: [] }));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
