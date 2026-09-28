import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MFA_SETUP_REQUIRED_DETAIL, api, tokenStore } from '../api/client';
import { WithSession, testSession } from '../test/session';
import { RequireStaff, StaffAuthProvider } from './StaffAuth';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const mocks = vi.hoisted(() => ({ setup: vi.fn(), enable: vi.fn(), session: vi.fn() }));

vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;base64,AAAA') } }));
vi.mock('../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/auth')>();
  return { ...actual, mfaApi: { ...actual.mfaApi, setup: mocks.setup, enable: mocks.enable } };
});
vi.mock('../api/me', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/me')>();
  return { ...actual, meApi: { ...actual.meApi, session: mocks.session } };
});

function routes(page: JSX.Element) {
  return (
    <MemoryRouter initialEntries={['/portal/calendar']} future={ROUTER_FUTURE}>
      <Routes>
        <Route path="/portal/calendar" element={<RequireStaff>{page}</RequireStaff>} />
        <Route path="/login" element={<p>Sign-in page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

/** A signed-in person who must enroll; reloading the session finds 2FA turned on. */
function EnrollingPerson({ onReload, onLogout }: { onReload: () => void; onLogout: () => Promise<void> }) {
  const [session, setSessionState] = useState(testSession({ mfa_setup_required: true }));
  const setSession = async () => {
    onReload();
    setSessionState(testSession({ staff: { mfa_enabled: true } }));
  };
  return (
    <WithSession session={session} setSession={setSession} logout={onLogout}>
      {routes(<p>Calendar page</p>)}
    </WithSession>
  );
}

describe('two-factor enrollment before using the app', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.setup.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/Synari:dana' });
    mocks.enable.mockResolvedValue({ recovery_codes: ['aaaa-1111', 'bbbb-2222'] });
  });

  it('shows the setup screen instead of the page, then continues to it once recovery codes are saved', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    render(<EnrollingPerson onReload={onReload} onLogout={() => Promise.resolve()} />);

    expect(await screen.findByRole('heading', { name: 'Set up two-factor authentication' })).toBeInTheDocument();
    expect(screen.queryByText('Calendar page')).not.toBeInTheDocument();
    expect(screen.getByText(/Everyone at Lee Counseling signs in with a code/)).toBeInTheDocument();
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/6-digit code/), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(mocks.enable).toHaveBeenCalledWith('123456');
    expect(await screen.findByText('aaaa-1111')).toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Calendar page')).toBeInTheDocument();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('lets them sign out instead', async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn(() => Promise.resolve());
    render(<EnrollingPerson onReload={vi.fn()} onLogout={onLogout} />);

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });
});

describe('StaffAuthProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('switches to the setup screen when the practice starts requiring two-factor mid-session', async () => {
    const user = userEvent.setup();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.setup.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/Synari:dana' });
    mocks.session.mockResolvedValueOnce(testSession()).mockResolvedValue(testSession({ mfa_setup_required: true }));
    const exp = Math.floor(Date.now() / 1000) + 900;
    tokenStore.set('staff', { access_token: `h.${btoa(JSON.stringify({ exp }))}.s`, refresh_token: 'r', expires_in: 900 });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ detail: MFA_SETUP_REQUIRED_DETAIL }), { status: 403 }))),
    );

    render(
      <StaffAuthProvider>
        {routes(
          <button type="button" onClick={() => void api('/clients').catch(() => undefined)}>
            Load clients
          </button>,
        )}
      </StaffAuthProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Load clients' }));
    expect(await screen.findByRole('heading', { name: 'Set up two-factor authentication' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.session).toHaveBeenCalledTimes(2));
  });
});
