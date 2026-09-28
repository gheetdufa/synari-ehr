import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../api/auth';
import { ApiError } from '../../../api/client';
import type { EmergencyGrantReview } from '../../../api/emergencyAccess';
import type { AuthSession, PracticeSecurity, SecurityEvent } from '../../../api/security';
import { WithSession, testSession } from '../../../test/session';
import { ToastProvider } from '../../../ui/Toast';
import { SecuritySettings } from '../SecuritySettings';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const security = vi.hoisted(() => ({
  sessions: vi.fn(),
  revokeSession: vi.fn(),
  practice: vi.fn(),
  updatePractice: vi.fn(),
  events: vi.fn(),
  acknowledgeEvent: vi.fn(),
}));
const emergency = vi.hoisted(() => ({ reviews: vi.fn(), markReviewed: vi.fn(), revoke: vi.fn() }));
const auth = vi.hoisted(() => ({ changePassword: vi.fn() }));

vi.mock('../../../api/security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/security')>();
  return { ...actual, securityApi: { ...actual.securityApi, ...security } };
});
vi.mock('../../../api/emergencyAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/emergencyAccess')>();
  return { ...actual, emergencyAccessApi: { ...actual.emergencyAccessApi, ...emergency } };
});
vi.mock('../../../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/auth')>();
  return { ...actual, staffAuth: { ...actual.staffAuth, ...auth } };
});

const NOW = new Date().toISOString();
const LATER = new Date(Date.now() + 3 * 60 * 60_000).toISOString();

const SESSIONS: AuthSession[] = [
  {
    id: 'sess-current',
    device: 'Chrome on macOS',
    user_agent: 'Mozilla/5.0 (Macintosh)',
    ip_address: '203.0.113.5',
    created_at: NOW,
    last_seen_at: NOW,
    expires_at: LATER,
    current: true,
  },
  {
    id: 'sess-phone',
    device: 'Safari on iPhone',
    user_agent: 'Mozilla/5.0 (iPhone)',
    ip_address: '198.51.100.7',
    created_at: NOW,
    last_seen_at: NOW,
    expires_at: LATER,
    current: false,
  },
];

const PRACTICE: PracticeSecurity = {
  require_staff_mfa: false,
  mfa_server_policy: null,
  mfa_required: false,
  session_idle_minutes: 30,
  staff_mfa_enabled: 3,
  staff_active: 5,
};

function securityEvent(id: number, changes: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    id,
    kind: 'login.failed_repeatedly',
    label: 'Repeated failed sign-ins',
    severity: 'warning',
    staff_id: 2,
    staff_name: 'Jordan Park',
    detail: null,
    created_at: NOW,
    acknowledged_at: null,
    acknowledged_by_name: '',
    ...changes,
  };
}

function grantReview(id: number, changes: Partial<EmergencyGrantReview> = {}): EmergencyGrantReview {
  return {
    id,
    staff_id: 2,
    staff_name: 'Jordan Park',
    client_id: 7,
    client_name: 'Alex Rivera',
    reason: 'Client called in crisis and Dana is on leave',
    created_at: NOW,
    expires_at: LATER,
    revoked_at: null,
    reviewed_at: null,
    reviewed_by_name: '',
    review_note: '',
    active: true,
    ...changes,
  };
}

const OWNER = testSession();

function renderSecurity(
  session: Session = OWNER,
  auth: { setSession?: () => Promise<void>; logoutEverywhere?: () => Promise<void> } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={session} setSession={auth.setSession} logoutEverywhere={auth.logoutEverywhere}>
          <MemoryRouter initialEntries={['/portal/settings']} future={ROUTER_FUTURE}>
            <Routes>
              <Route path="/portal/settings" element={<SecuritySettings />} />
              <Route path="/login" element={<p>Sign-in page</p>} />
            </Routes>
          </MemoryRouter>
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function card(title: string): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { name: title })).closest('.rounded-xl') as HTMLElement;
}

describe('SecuritySettings', () => {
  beforeEach(() => {
    [...Object.values(security), ...Object.values(emergency), ...Object.values(auth)].forEach((mock) => mock.mockReset());
    security.sessions.mockResolvedValue(SESSIONS);
    security.practice.mockResolvedValue(PRACTICE);
    security.events.mockResolvedValue([securityEvent(11)]);
    emergency.reviews.mockResolvedValue([grantReview(21)]);
  });

  it.each([
    ['an owner', OWNER, ['Practice security', 'Security events', 'Emergency access reviews']],
    [
      'a practice manager',
      testSession({ staff: { role: 'practice_manager' }, capabilities: ['manage_team', 'manage_practice', 'view_audit_log'] }),
      ['Practice security', 'Security events'],
    ],
    [
      'an auditor without team management',
      testSession({ staff: { role: 'biller', is_clinician: false }, capabilities: ['billing_all', 'view_audit_log'] }),
      ['Security events'],
    ],
    ['a clinician', testSession({ staff: { role: 'clinician' }, capabilities: [] }), []],
  ])('shows %s the cards for their role, in order', async (_who, session, practiceCards) => {
    renderSecurity(session);
    // The two-factor card's heading ends with its On/Off badge.
    const personal = ['Two-factor authenticationOff', 'Change password', 'Your sessions'];
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
        ...personal,
        ...practiceCards,
      ]),
    );
  });

  describe('your sessions', () => {
    it('marks this device and signs out another one', async () => {
      const user = userEvent.setup();
      security.revokeSession.mockResolvedValue(undefined);
      renderSecurity();
      const sessions = await card('Your sessions');

      const current = (await within(sessions).findByText('Chrome on macOS')).closest('li') as HTMLElement;
      expect(within(current).getByText('This device')).toBeInTheDocument();
      expect(within(current).queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();

      await user.click(within(sessions).getByRole('button', { name: 'Sign out Safari on iPhone' }));
      await waitFor(() => expect(security.revokeSession).toHaveBeenCalledWith('sess-phone'));
      expect(await screen.findByText('Signed out Safari on iPhone')).toBeInTheDocument();
    });

    it('signs out everywhere after confirming, then goes to sign-in', async () => {
      const user = userEvent.setup();
      const logoutEverywhere = vi.fn(() => Promise.resolve());
      renderSecurity(OWNER, { logoutEverywhere });

      await user.click(within(await card('Your sessions')).getByRole('button', { name: 'Sign out everywhere' }));
      const dialog = screen.getByRole('dialog', { name: 'Sign out everywhere?' });
      await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));

      expect(logoutEverywhere).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    });

    it('stays signed in and explains when signing out everywhere fails', async () => {
      const user = userEvent.setup();
      renderSecurity(OWNER, { logoutEverywhere: () => Promise.reject(new ApiError(0, null)) });

      await user.click(within(await card('Your sessions')).getByRole('button', { name: 'Sign out everywhere' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out everywhere' }));

      expect(await screen.findByText("Can't reach the server. Check your connection and try again.")).toBeInTheDocument();
      expect(screen.queryByText('Sign-in page')).not.toBeInTheDocument();
    });
  });

  describe('practice security', () => {
    /** The card once its settings have loaded (the loading placeholder is a different card). */
    async function practiceCard(): Promise<HTMLElement> {
      await screen.findByRole('switch', { name: /Require two-factor authentication/ });
      return card('Practice security');
    }

    it('requires two-factor for the team and shortens the idle limit', async () => {
      const user = userEvent.setup();
      const setSession = vi.fn(() => Promise.resolve());
      security.updatePractice.mockResolvedValue({ ...PRACTICE, require_staff_mfa: true, mfa_required: true, session_idle_minutes: 15 });
      renderSecurity(OWNER, { setSession });
      const practice = await practiceCard();

      expect(within(practice).getByText('3 of 5 active team members use 2FA')).toBeInTheDocument();
      await user.click(within(practice).getByRole('switch', { name: /Require two-factor authentication/ }));
      expect(within(practice).getByText(/2 active team members haven't set up two-factor authentication yet, including you/)).toBeInTheDocument();
      await user.selectOptions(within(practice).getByLabelText('Sign people out after'), '15');
      await user.click(within(practice).getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(security.updatePractice).toHaveBeenCalledWith({ require_staff_mfa: true, session_idle_minutes: 15 }),
      );
      await waitFor(() => expect(setSession).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('Security settings saved')).toBeInTheDocument();
    });

    it('locks the two-factor rule when the server administrator sets it', async () => {
      security.practice.mockResolvedValue({ ...PRACTICE, mfa_server_policy: 'required', mfa_required: true });
      renderSecurity();
      const practice = await practiceCard();
      const toggle = within(practice).getByRole('switch', { name: /Require two-factor authentication/ });
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(within(practice).getByText('Set by the server administrator.')).toBeInTheDocument();
    });
  });

  describe('security events', () => {
    it('acknowledges an event that needs review', async () => {
      const user = userEvent.setup();
      security.acknowledgeEvent.mockResolvedValue(securityEvent(11, { acknowledged_at: NOW, acknowledged_by_name: 'Dana Lee' }));
      renderSecurity();
      const events = await card('Security events');

      expect(await within(events).findByText('Repeated failed sign-ins')).toBeInTheDocument();
      expect(within(events).getByText('Warning')).toBeInTheDocument();
      expect(within(events).getByText(/Jordan Park/)).toBeInTheDocument();
      expect(security.events).toHaveBeenCalledWith(true, undefined);

      await user.click(within(events).getByRole('button', { name: 'Acknowledge: Repeated failed sign-ins' }));
      await waitFor(() => expect(security.acknowledgeEvent).toHaveBeenCalledWith(11));
      expect(await screen.findByText('Marked as reviewed')).toBeInTheDocument();
    });

    it('shows every event and loads older ones', async () => {
      const user = userEvent.setup();
      const page = Array.from({ length: 50 }, (_, index) =>
        securityEvent(200 - index, { acknowledged_at: NOW, acknowledged_by_name: 'Dana Lee', severity: 'info' }),
      );
      security.events.mockImplementation((needsReview: boolean, beforeId?: number) =>
        Promise.resolve(
          needsReview ? [] : beforeId ? [securityEvent(9, { label: 'Emergency access used', severity: 'critical' })] : page,
        ),
      );
      renderSecurity();
      const events = await card('Security events');

      expect(await within(events).findByText('Nothing needs review')).toBeInTheDocument();
      await user.click(within(events).getByRole('tab', { name: 'All' }));
      expect(await within(events).findAllByText(/Reviewed by Dana Lee/)).toHaveLength(50);
      expect(within(events).queryByRole('button', { name: /Acknowledge/ })).not.toBeInTheDocument();

      await user.click(within(events).getByRole('button', { name: 'Load more' }));
      expect(await within(events).findByText('Emergency access used')).toBeInTheDocument();
      expect(within(events).getByText('Critical')).toBeInTheDocument();
      expect(security.events).toHaveBeenLastCalledWith(false, 151);
    });
  });

  describe('emergency access reviews', () => {
    it('shows who opened which chart and why, and records a review note', async () => {
      const user = userEvent.setup();
      emergency.markReviewed.mockResolvedValue(grantReview(21, { reviewed_at: NOW, reviewed_by_name: 'Dana Lee' }));
      renderSecurity();
      const reviews = await card('Emergency access reviews');

      expect(await within(reviews).findByText('Client called in crisis and Dana is on leave')).toBeInTheDocument();
      expect(within(reviews).getByRole('link', { name: 'Alex Rivera' })).toHaveAttribute('href', '/portal/clients/7');
      expect(within(reviews).getByText(/^Active until/)).toBeInTheDocument();
      expect(emergency.reviews).toHaveBeenCalledWith(true);

      await user.click(within(reviews).getByRole('button', { name: 'Mark reviewed' }));
      const dialog = screen.getByRole('dialog', { name: 'Mark as reviewed' });
      await user.type(within(dialog).getByLabelText(/Review note/), 'Confirmed with Jordan by phone.');
      await user.click(within(dialog).getByRole('button', { name: 'Mark reviewed' }));

      await waitFor(() => expect(emergency.markReviewed).toHaveBeenCalledWith(21, 'Confirmed with Jordan by phone.'));
      expect(await screen.findByText('Marked as reviewed')).toBeInTheDocument();
    });

    it('ends access that is still open after confirming', async () => {
      const user = userEvent.setup();
      emergency.revoke.mockResolvedValue(grantReview(21, { active: false, revoked_at: NOW }));
      renderSecurity();
      const reviews = await card('Emergency access reviews');

      await user.click(await within(reviews).findByRole('button', { name: 'End access now' }));
      const dialog = screen.getByRole('dialog', { name: "End Jordan Park's emergency access?" });
      await user.click(within(dialog).getByRole('button', { name: 'End access now' }));

      await waitFor(() => expect(emergency.revoke).toHaveBeenCalledWith(21));
      expect(await screen.findByText("Jordan Park's emergency access has ended")).toBeInTheDocument();
    });

    it('lists reviewed and ended access under All', async () => {
      const user = userEvent.setup();
      emergency.reviews.mockImplementation((pendingOnly: boolean) =>
        Promise.resolve(
          pendingOnly
            ? []
            : [grantReview(20, { active: false, revoked_at: NOW, reviewed_at: NOW, reviewed_by_name: 'Dana Lee', review_note: 'Appropriate.' })],
        ),
      );
      renderSecurity();
      const reviews = await card('Emergency access reviews');

      expect(await within(reviews).findByText('Nothing to review')).toBeInTheDocument();
      await user.click(within(reviews).getByRole('tab', { name: 'All' }));
      expect(await within(reviews).findByText('Ended early')).toBeInTheDocument();
      expect(within(reviews).getByText('Appropriate.')).toBeInTheDocument();
      expect(within(reviews).queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
      expect(within(reviews).queryByRole('button', { name: 'End access now' })).not.toBeInTheDocument();
    });
  });

  describe('change password', () => {
    async function submitChange(user: ReturnType<typeof userEvent.setup>) {
      const form = await card('Change password');
      await user.type(within(form).getByLabelText(/Current password/), 'my old password');
      await user.type(within(form).getByLabelText(/^New password/), 'a calm river stone');
      await user.type(within(form).getByLabelText(/Confirm new password/), 'a calm river stone');
      await user.click(within(form).getByRole('button', { name: 'Change password' }));
      return form;
    }

    it('asks for 12 characters before sending anything', async () => {
      const user = userEvent.setup();
      renderSecurity();
      const form = await card('Change password');
      expect(within(form).getByText(/At least 12 characters. A few unrelated words/)).toBeInTheDocument();
      await user.type(within(form).getByLabelText(/Current password/), 'my old password');
      await user.type(within(form).getByLabelText(/^New password/), 'short pass');
      await user.click(within(form).getByRole('button', { name: 'Change password' }));
      expect(within(form).getByText('Use at least 12 characters')).toBeInTheDocument();
      expect(auth.changePassword).not.toHaveBeenCalled();
    });

    it('shows a wrong current password on that field', async () => {
      const user = userEvent.setup();
      auth.changePassword.mockRejectedValue(new ApiError(400, 'Current password is incorrect'));
      renderSecurity();
      const form = await submitChange(user);
      expect(await within(form).findByText('Current password is incorrect')).toBeInTheDocument();
      expect(within(form).getByLabelText(/Current password/)).toHaveAttribute('aria-invalid', 'true');
    });

    it('shows a rejected new password on the new password field', async () => {
      const user = userEvent.setup();
      auth.changePassword.mockRejectedValue(new ApiError(400, 'This password is too common. Choose something less predictable.'));
      renderSecurity();
      const form = await submitChange(user);
      expect(await within(form).findByText('This password is too common. Choose something less predictable.')).toBeInTheDocument();
      expect(within(form).getByLabelText(/^New password/)).toHaveAttribute('aria-invalid', 'true');
      expect(within(form).getByLabelText(/Current password/)).not.toHaveAttribute('aria-invalid');
    });
  });
});
