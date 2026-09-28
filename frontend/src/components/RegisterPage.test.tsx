import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterInput, Session } from '../api/auth';
import { ApiError } from '../api/client';
import { StaffAuthContext, type StaffAuthValue } from '../auth/StaffAuth';
import { testSession } from '../test/session';
import RegisterPage from './RegisterPage';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  updateProfile: vi.fn(),
  reloadSession: vi.fn(),
  setup: vi.fn(),
  enable: vi.fn(),
}));

vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;base64,AAAA') } }));
vi.mock('../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/auth')>();
  return { ...actual, mfaApi: { ...actual.mfaApi, setup: mocks.setup, enable: mocks.enable } };
});
vi.mock('../api/me', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/me')>();
  return { ...actual, meApi: { ...actual.meApi, updateProfile: mocks.updateProfile } };
});

/** Sign-in state around the page, with `register` and `setSession` backed by the mocks. */
function Harness() {
  const [session, setSessionState] = useState<Session | null>(null);
  const unused = () => Promise.reject(new Error('Not used'));
  const value: StaffAuthValue = {
    status: session ? 'signedIn' : 'signedOut',
    session,
    login: unused,
    completeMfa: unused,
    acceptInvitation: unused,
    logoutEverywhere: unused,
    logout: async () => setSessionState(null),
    register: async (input: RegisterInput) => {
      const created = (await mocks.register(input)) as Session;
      setSessionState(created);
      return created;
    },
    setSession: async (next?: Session) => {
      setSessionState(next ?? ((await mocks.reloadSession()) as Session));
    },
  };
  return (
    <StaffAuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/register']} future={ROUTER_FUTURE}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/portal/settings" element={<p>Welcome checklist</p>} />
          <Route path="/portal" element={<p>Portal home</p>} />
        </Routes>
      </MemoryRouter>
    </StaffAuthContext.Provider>
  );
}

async function fillForm(user: ReturnType<typeof userEvent.setup>, password: string) {
  await user.type(screen.getByLabelText(/First Name/), 'Dana');
  await user.type(screen.getByLabelText(/Last Name/), 'Lee');
  await user.type(screen.getByLabelText(/Email address/), 'dana@example.com');
  await user.type(screen.getByLabelText(/^Password/), password);
  await user.type(screen.getByLabelText(/Confirm Password/), password);
  await user.type(screen.getByLabelText(/License Number/), 'LCSW-123');
  await user.selectOptions(screen.getByLabelText(/License State/), 'OR');
  await user.click(screen.getByRole('button', { name: 'Create Account' }));
}

describe('RegisterPage', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.setup.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/Synari:dana' });
    mocks.enable.mockResolvedValue({ recovery_codes: ['aaaa-1111'] });
    mocks.updateProfile.mockResolvedValue(testSession({ staff: { license_number: 'LCSW-123', license_state: 'OR' } }));
  });

  it('asks for at least 12 characters', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText(/A few unrelated words make a strong, memorable password/)).toBeInTheDocument();
    await fillForm(user, 'eleven-char');
    expect(screen.getByText('Use at least 12 characters')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("shows the server's password rejection on the password field", async () => {
    const user = userEvent.setup();
    mocks.register.mockRejectedValue(
      new ApiError(400, "Don't base your password on your name, email or practice name."),
    );
    render(<Harness />);
    await fillForm(user, 'dana lee counseling');
    expect(await screen.findByText("Don't base your password on your name, email or practice name.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('sets up two-factor first when the server requires it, then saves the license', async () => {
    const user = userEvent.setup();
    mocks.register.mockResolvedValue(testSession({ mfa_setup_required: true }));
    mocks.reloadSession.mockResolvedValue(testSession({ staff: { mfa_enabled: true } }));
    render(<Harness />);

    await fillForm(user, 'a calm river stone');
    expect(await screen.findByRole('heading', { name: 'Set up two-factor authentication' })).toBeInTheDocument();
    expect(mocks.updateProfile).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/6-digit code/), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Welcome checklist')).toBeInTheDocument();
    expect(mocks.reloadSession).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mocks.updateProfile).toHaveBeenCalledWith({ license_number: 'LCSW-123', license_state: 'OR' }),
    );
  });

  it('saves the license right away when two-factor is not required', async () => {
    const user = userEvent.setup();
    mocks.register.mockResolvedValue(testSession());
    render(<Harness />);

    await fillForm(user, 'a calm river stone');
    expect(await screen.findByText('Welcome checklist')).toBeInTheDocument();
    expect(mocks.updateProfile).toHaveBeenCalledWith({ license_number: 'LCSW-123', license_state: 'OR' });
    expect(mocks.setup).not.toHaveBeenCalled();
  });
});
