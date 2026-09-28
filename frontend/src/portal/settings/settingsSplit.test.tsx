import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capability, Session } from '../../api/auth';
import type { StaffPreferences } from '../../api/me';
import type { PracticeSettings } from '../../api/practice';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { BillingSettings } from './BillingSettings';
import { MessagingSettings } from './MessagingSettings';
import { NotificationSettings } from './NotificationSettings';
import { ProfileSettings } from './ProfileSettings';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const api = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  updatePreferences: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock('../../api/practice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/practice')>();
  return { ...actual, practiceApi: { ...actual.practiceApi, updateSettings: api.updateSettings } };
});
vi.mock('../../api/me', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/me')>();
  return {
    ...actual,
    meApi: { ...actual.meApi, updatePreferences: api.updatePreferences, updateProfile: api.updateProfile },
  };
});
vi.mock('../../lib/usePublicConfig', () => ({
  usePublicConfig: () => ({ email_enabled: true, sms_enabled: true, telehealth_enabled: true, payments_enabled: true, ai_enabled: true }),
}));

const SETTINGS: PracticeSettings = {
  cancellation_window_hours: 24,
  booking_enabled: true,
  booking_accepts_new_clients: true,
  booking_min_notice_hours: 24,
  booking_max_days_ahead: 60,
  booking_slot_interval_minutes: 0,
  booking_intro: '',
  reminder_email_enabled: true,
  reminder_email_hours: 24,
  reminder_sms_enabled: false,
  reminder_sms_hours: 24,
  messaging_enabled: true,
  waiting_room_enabled: true,
  recording_enabled: false,
  bill_missed_appointments: false,
  autopay_enabled: false,
  invoice_due_days: 0,
  record_retention_years: 7,
  gfe_enabled: true,
};

const PREFERENCES: StaffPreferences = {
  away_message_enabled: false,
  away_message: '',
  note_format_default: 'SOAP',
  ai_style_instructions: '',
  notify_email_messages: true,
  notify_email_requests: true,
  notify_email_forms: true,
};

const MANAGER: Capability[] = ['manage_practice', 'manage_team'];

function renderWith(ui: ReactNode, session: Session, setSession = vi.fn(() => Promise.resolve())) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={session} setSession={setSession}>
          <MemoryRouter future={ROUTER_FUTURE}>{ui}</MemoryRouter>
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { setSession };
}

function card(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('form') as HTMLElement;
}

describe('practice-wide settings vs personal preferences', () => {
  beforeEach(() => {
    api.updateSettings.mockReset().mockImplementation((changes: Partial<PracticeSettings>) =>
      Promise.resolve({ ...SETTINGS, ...changes }),
    );
    api.updatePreferences.mockReset().mockImplementation((changes: Partial<StaffPreferences>) =>
      Promise.resolve({ ...PREFERENCES, ...changes }),
    );
    api.updateProfile.mockReset();
  });

  it('saves client reminders to the practice and email notices to your own preferences', async () => {
    const user = userEvent.setup();
    renderWith(
      <NotificationSettings settings={SETTINGS} preferences={PREFERENCES} />,
      testSession({ capabilities: MANAGER }),
    );

    const reminders = card('Client appointment reminders');
    await user.click(within(reminders).getByRole('switch', { name: /Text message reminders/ }));
    await user.click(within(reminders).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ reminder_sms_enabled: true }));

    const notices = card('Email me when');
    await user.click(within(notices).getByRole('switch', { name: 'A client sends me a message' }));
    await user.click(within(notices).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ notify_email_messages: false }));
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("shows practice-wide settings read-only to people who don't manage the practice", async () => {
    const user = userEvent.setup();
    renderWith(
      <MessagingSettings settings={SETTINGS} preferences={PREFERENCES} />,
      testSession({ staff: { role: 'clinician' }, capabilities: [] }),
    );

    const practice = card('Secure messaging');
    expect(within(practice).getByRole('switch', { name: /Secure messaging/ })).toBeDisabled();
    expect(within(practice).queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(within(practice).getByText(/Only team members who manage the practice/)).toBeInTheDocument();

    const away = card('Your away message');
    await user.click(within(away).getByRole('switch', { name: 'Away message' }));
    await user.click(within(away).getByRole('button', { name: 'Save changes' }));
    expect(await within(away).findByText('Write the message clients will see while you are away')).toBeInTheDocument();
    await user.type(within(away).getByLabelText('Away message text'), 'Back Monday.');
    await user.click(within(away).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({ away_message_enabled: true, away_message: 'Back Monday.' }),
    );
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("doesn't offer an away message to staff who don't see clients", () => {
    renderWith(
      <MessagingSettings settings={SETTINGS} preferences={PREFERENCES} />,
      testSession({ staff: { role: 'biller', is_clinician: false }, capabilities: ['billing_all'] }),
    );
    expect(screen.queryByRole('heading', { name: 'Your away message' })).not.toBeInTheDocument();
  });

  it('saves your profile through /me and adopts the returned session', async () => {
    const user = userEvent.setup();
    const session = testSession();
    const updated = testSession({ staff: { credentials: 'LCSW, CST' } });
    api.updateProfile.mockResolvedValue(updated);
    const { setSession } = renderWith(<ProfileSettings />, session);

    const credentials = screen.getByLabelText('Credentials');
    await user.clear(credentials);
    await user.type(credentials, 'LCSW, CST ');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith({ credentials: 'LCSW, CST' }));
    expect(setSession).toHaveBeenCalledWith(updated);
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it('turns good faith estimates off for the practice', async () => {
    const user = userEvent.setup();
    renderWith(<BillingSettings settings={SETTINGS} />, testSession({ capabilities: MANAGER }));

    const billing = card('Billing');
    const toggle = within(billing).getByRole('switch', { name: /Good faith estimates for self-pay clients/ });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    await user.click(within(billing).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ gfe_enabled: false }));
  });
});
