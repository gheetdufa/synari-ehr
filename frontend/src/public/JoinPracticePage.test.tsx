import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invitation } from '../api/auth';
import { ApiError } from '../api/client';
import { StaffAuthProvider, useSession } from '../auth/StaffAuth';
import { testSession } from '../test/session';
import JoinPracticePage, { roleWithArticle } from './JoinPracticePage';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const auth = vi.hoisted(() => ({ invitation: vi.fn(), acceptInvitation: vi.fn() }));

vi.mock('../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/auth')>();
  return { ...actual, staffAuth: { ...actual.staffAuth, ...auth } };
});

const INVITATION: Invitation = {
  email: 'jordan@example.com',
  first_name: 'Jordan',
  last_name: 'Park',
  practice_name: 'Lee Counseling',
  role: 'clinician',
};

function PortalHome() {
  const { staff, practice } = useSession();
  return (
    <p>
      Signed in as {staff.first_name} at {practice.name}
    </p>
  );
}

function renderPage(url: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <StaffAuthProvider>
        <MemoryRouter initialEntries={[url]} future={ROUTER_FUTURE}>
          <Routes>
            <Route path="/join-practice" element={<JoinPracticePage />} />
            <Route path="/portal" element={<PortalHome />} />
          </Routes>
        </MemoryRouter>
      </StaffAuthProvider>
    </QueryClientProvider>,
  );
}

describe('JoinPracticePage', () => {
  beforeEach(() => {
    auth.invitation.mockReset();
    auth.acceptInvitation.mockReset();
  });

  it('greets the invitee, lets them fix their name and choose a password, then signs them in', async () => {
    const user = userEvent.setup();
    auth.invitation.mockResolvedValue(INVITATION);
    auth.acceptInvitation.mockResolvedValue(testSession({ staff: { first_name: 'Jordy' } }));
    renderPage('/join-practice?token=abc123');

    expect(await screen.findByRole('heading', { name: 'Join Lee Counseling as a clinician' })).toBeInTheDocument();
    expect(auth.invitation).toHaveBeenCalledWith('abc123');
    expect(screen.getByText('jordan@example.com')).toBeInTheDocument();
    const firstName = screen.getByLabelText(/First name/);
    expect(firstName).toHaveValue('Jordan');
    expect(screen.getByLabelText(/Last name/)).toHaveValue('Park');

    await user.clear(firstName);
    await user.type(firstName, 'Jordy ');
    await user.type(screen.getByLabelText(/^Password/), 'short');
    await user.type(screen.getByLabelText(/Confirm password/), 'different');
    await user.click(screen.getByRole('button', { name: 'Join Lee Counseling' }));
    expect(screen.getByText('Use at least 12 characters')).toBeInTheDocument();
    expect(screen.getByText("Passwords don't match")).toBeInTheDocument();
    expect(auth.acceptInvitation).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/^Password/));
    await user.type(screen.getByLabelText(/^Password/), 'a calm river stone');
    await user.clear(screen.getByLabelText(/Confirm password/));
    await user.type(screen.getByLabelText(/Confirm password/), 'a calm river stone');
    await user.click(screen.getByRole('button', { name: 'Join Lee Counseling' }));

    await waitFor(() =>
      expect(auth.acceptInvitation).toHaveBeenCalledWith({
        token: 'abc123',
        password: 'a calm river stone',
        first_name: 'Jordy',
        last_name: 'Park',
      }),
    );
    expect(await screen.findByText('Signed in as Jordy at Lee Counseling')).toBeInTheDocument();
  });

  it('explains an expired or used invitation', async () => {
    auth.invitation.mockRejectedValue(
      new ApiError(400, 'This invitation is invalid or has expired. Ask your practice to send a new one.'),
    );
    renderPage('/join-practice?token=old');

    expect(await screen.findByRole('heading', { name: 'This invitation has expired' })).toBeInTheDocument();
    expect(screen.getByText(/Ask your practice to send you a new one/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('offers a retry when the server is unreachable', async () => {
    const user = userEvent.setup();
    auth.invitation.mockRejectedValueOnce(new ApiError(0, null)).mockResolvedValueOnce(INVITATION);
    renderPage('/join-practice?token=abc123');

    expect(await screen.findByText("Can't reach the server. Check your connection and try again.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Join Lee Counseling as a clinician' })).toBeInTheDocument();
  });

  it('asks for the link from the email when there is no token', () => {
    renderPage('/join-practice');
    expect(screen.getByText(/needs the link from your invitation email/)).toBeInTheDocument();
    expect(auth.invitation).not.toHaveBeenCalled();
  });

  it('shows why joining failed, for example when the link expired meanwhile', async () => {
    const user = userEvent.setup();
    auth.invitation.mockResolvedValue(INVITATION);
    auth.acceptInvitation.mockRejectedValue(new ApiError(400, 'This invitation is invalid or has expired.'));
    renderPage('/join-practice?token=abc123');

    await user.type(await screen.findByLabelText(/^Password/), 'a calm river stone');
    await user.type(screen.getByLabelText(/Confirm password/), 'a calm river stone');
    await user.click(screen.getByRole('button', { name: 'Join Lee Counseling' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This invitation is invalid or has expired.');
  });

  it("shows the server's password rejection on the password field", async () => {
    const user = userEvent.setup();
    auth.invitation.mockResolvedValue(INVITATION);
    auth.acceptInvitation.mockRejectedValue(
      new ApiError(400, 'This password has appeared in a data breach. Choose a different one.'),
    );
    renderPage('/join-practice?token=abc123');

    const password = await screen.findByLabelText(/^Password/);
    expect(screen.getByText(/A few unrelated words make a strong, memorable password/)).toBeInTheDocument();
    await user.type(password, 'password1234');
    await user.type(screen.getByLabelText(/Confirm password/), 'password1234');
    await user.click(screen.getByRole('button', { name: 'Join Lee Counseling' }));

    expect(await screen.findByText('This password has appeared in a data breach. Choose a different one.')).toBeInTheDocument();
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the right article for each role', () => {
    expect(roleWithArticle('owner')).toBe('an owner');
    expect(roleWithArticle('practice_manager')).toBe('a practice manager');
    expect(roleWithArticle('clinician')).toBe('a clinician');
  });
});
