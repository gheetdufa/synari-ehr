import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../api/auth';
import { ApiError } from '../../../api/client';
import type { TeamMember } from '../../../api/team';
import { WithSession, testSession } from '../../../test/session';
import { ToastProvider } from '../../../ui/Toast';
import { TeamSettings } from './TeamSettings';

const team = vi.hoisted(() => ({
  list: vi.fn(),
  invite: vi.fn(),
  deactivate: vi.fn(),
  resendInvitation: vi.fn(),
  signOutEverywhere: vi.fn(),
  resetMfa: vi.fn(),
}));

vi.mock('../../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, ...team } };
});

function member(id: number, changes: Partial<TeamMember>): TeamMember {
  return {
    id,
    email: `person${id}@example.com`,
    first_name: 'Person',
    last_name: String(id),
    display_name: `Person ${id}`,
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
    ...changes,
  };
}

const MEMBERS = [
  member(1, { first_name: 'Dana', last_name: 'Lee', display_name: 'Dana Lee, LCSW', role: 'owner' }),
  member(2, {
    first_name: 'Jordan',
    last_name: 'Park',
    display_name: 'Jordan Park, LMFT',
    clinician_access: 'client_list',
    supervisor_id: 1,
  }),
  member(3, {
    first_name: 'Sam',
    last_name: 'Ortiz',
    display_name: 'Sam Ortiz',
    role: 'biller',
    is_clinician: false,
    status: 'invited',
    invited_at: '2026-09-20T15:00:00Z',
  }),
];

const MANAGER = testSession({
  staff: { id: 4, first_name: 'Riley', last_name: 'Chen', role: 'practice_manager', is_clinician: false },
  capabilities: ['manage_team', 'manage_practice', 'view_all_clients', 'schedule_all', 'billing_all'],
});

function renderTeam(session: Session) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={session}>
          <TeamSettings />
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openActions(user: ReturnType<typeof userEvent.setup>, name: string) {
  const [button] = await screen.findAllByRole('button', { name: `Actions for ${name}` });
  await user.click(button);
  return screen.getByRole('menu', { name: `Actions for ${name}` });
}

describe('TeamSettings', () => {
  beforeEach(() => {
    Object.values(team).forEach((mock) => mock.mockReset());
    team.list.mockResolvedValue(MEMBERS);
  });

  it('lists the team with roles, supervisors and status', async () => {
    renderTeam(MANAGER);
    const table = await screen.findByRole('table');
    const jordan = within(table).getByText('Jordan Park, LMFT').closest('tr') as HTMLElement;
    expect(within(jordan).getByText('Clinician · Entire client list')).toBeInTheDocument();
    expect(within(jordan).getByText('Supervised by Dana Lee, LCSW')).toBeInTheDocument();
    expect(within(jordan).getByText('Active')).toBeInTheDocument();
    const sam = within(table).getByText('Sam Ortiz').closest('tr') as HTMLElement;
    expect(within(sam).getByText('Invited')).toBeInTheDocument();
  });

  it("doesn't let a practice manager manage the owner", async () => {
    const user = userEvent.setup();
    renderTeam(MANAGER);
    const menu = await openActions(user, 'Dana Lee');
    expect(within(menu).queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Deactivate' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Services & rates' })).toBeInTheDocument();
  });

  it('confirms before deactivating and shows the reason when the API refuses', async () => {
    const user = userEvent.setup();
    team.deactivate.mockRejectedValue(new ApiError(400, 'Reassign their clients before deactivating them'));
    renderTeam(MANAGER);

    const menu = await openActions(user, 'Jordan Park');
    await user.click(within(menu).getByRole('menuitem', { name: 'Deactivate' }));
    const dialog = screen.getByRole('dialog', { name: 'Deactivate Jordan Park?' });
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(team.deactivate).toHaveBeenCalledWith(2));
    expect(await screen.findByText('Reassign their clients before deactivating them')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resends a pending invitation', async () => {
    const user = userEvent.setup();
    team.resendInvitation.mockResolvedValue({ detail: 'Invitation sent to person3@example.com' });
    renderTeam(MANAGER);
    const menu = await openActions(user, 'Sam Ortiz');
    await user.click(within(menu).getByRole('menuitem', { name: 'Resend invitation' }));
    expect(await screen.findByText('Invitation sent to person3@example.com')).toBeInTheDocument();
  });

  describe('sign-in security', () => {
    const WITH_2FA = MEMBERS.map((person) => (person.id === 2 ? { ...person, mfa_enabled: true } : person));

    it('shows who uses two-factor authentication', async () => {
      team.list.mockResolvedValue(WITH_2FA);
      renderTeam(MANAGER);
      const table = await screen.findByRole('table');
      const row = (name: string) => within(table).getByText(name).closest('tr') as HTMLElement;
      expect(within(row('Jordan Park, LMFT')).getByText('2FA on')).toBeInTheDocument();
      expect(within(row('Dana Lee, LCSW')).getByText('No 2FA')).toBeInTheDocument();
      expect(within(row('Sam Ortiz')).queryByText(/2FA/)).not.toBeInTheDocument();
    });

    it('lets a manager sign someone out of all devices, but only owners reset 2FA', async () => {
      const user = userEvent.setup();
      team.list.mockResolvedValue(WITH_2FA);
      team.signOutEverywhere.mockResolvedValue(undefined);
      renderTeam(MANAGER);

      const menu = await openActions(user, 'Jordan Park');
      expect(within(menu).queryByRole('menuitem', { name: 'Reset 2FA' })).not.toBeInTheDocument();
      await user.click(within(menu).getByRole('menuitem', { name: 'Sign out of all devices' }));
      const dialog = screen.getByRole('dialog', { name: 'Sign Jordan Park out of all devices?' });
      await user.click(within(dialog).getByRole('button', { name: 'Sign out of all devices' }));

      await waitFor(() => expect(team.signOutEverywhere).toHaveBeenCalledWith(2));
      expect(await screen.findByText('Jordan Park was signed out of all devices')).toBeInTheDocument();
      const owner = await openActions(user, 'Dana Lee');
      expect(within(owner).queryByRole('menuitem', { name: 'Sign out of all devices' })).not.toBeInTheDocument();
    });

    it("lets an owner reset a member's 2FA after confirming, and not their own", async () => {
      const user = userEvent.setup();
      team.list.mockResolvedValue(WITH_2FA);
      team.resetMfa.mockResolvedValue({ ...WITH_2FA[1], mfa_enabled: false });
      renderTeam(testSession());

      const self = await openActions(user, 'Dana Lee');
      expect(within(self).queryByRole('menuitem', { name: 'Sign out of all devices' })).not.toBeInTheDocument();
      expect(within(self).queryByRole('menuitem', { name: 'Reset 2FA' })).not.toBeInTheDocument();

      const menu = await openActions(user, 'Jordan Park');
      await user.click(within(menu).getByRole('menuitem', { name: 'Reset 2FA' }));
      const dialog = screen.getByRole('dialog', { name: 'Reset two-factor authentication for Jordan Park?' });
      expect(within(dialog).getByText(/sure who is asking/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Reset 2FA' }));

      await waitFor(() => expect(team.resetMfa).toHaveBeenCalledWith(2));
      expect(await screen.findByText('Two-factor authentication reset for Jordan Park')).toBeInTheDocument();
    });

    it("doesn't offer a 2FA reset to someone who doesn't use it", async () => {
      const user = userEvent.setup();
      renderTeam(testSession());
      const menu = await openActions(user, 'Jordan Park');
      expect(within(menu).getByRole('menuitem', { name: 'Sign out of all devices' })).toBeInTheDocument();
      expect(within(menu).queryByRole('menuitem', { name: 'Reset 2FA' })).not.toBeInTheDocument();
    });
  });

  it('shows the team without management actions to a basic clinician', async () => {
    renderTeam(testSession({ staff: { id: 2, role: 'clinician' }, capabilities: [] }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });

  describe('invite form', () => {
    it('explains what is missing before sending anything', async () => {
      const user = userEvent.setup();
      renderTeam(MANAGER);
      await user.click(await screen.findByRole('button', { name: 'Invite' }));
      const dialog = screen.getByRole('dialog', { name: 'Invite a team member' });
      await user.type(within(dialog).getByLabelText(/Email/), 'jordan@');
      await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));

      expect(within(dialog).getByText('Enter a valid email address, like name@example.com')).toBeInTheDocument();
      expect(within(dialog).getByText('Enter their first name')).toBeInTheDocument();
      expect(within(dialog).getByText('Enter their last name')).toBeInTheDocument();
      expect(team.invite).not.toHaveBeenCalled();
    });

    it('invites a supervised clinician with an access level', async () => {
      const user = userEvent.setup();
      team.invite.mockImplementation((input: { email: string }) => Promise.resolve(member(9, { email: input.email })));
      renderTeam(MANAGER);
      await user.click(await screen.findByRole('button', { name: 'Invite' }));
      const dialog = screen.getByRole('dialog', { name: 'Invite a team member' });

      const roles = within(within(dialog).getByLabelText('Role')).getAllByRole('option').map((option) => option.textContent);
      expect(roles).toEqual(['Clinician', 'Practice manager', 'Biller', 'Scheduler']);
      expect(within(dialog).getByText('Sees and schedules every client, but opens only their own charts.')).toBeInTheDocument();

      await user.type(within(dialog).getByLabelText(/First name/), 'Alex');
      await user.type(within(dialog).getByLabelText(/Last name/), 'Kim');
      await user.type(within(dialog).getByLabelText(/Email/), 'alex@example.com');
      await user.click(within(dialog).getByRole('radio', { name: /Billing/ }));
      await user.selectOptions(within(dialog).getByLabelText('Supervisor'), 'Jordan Park, LMFT');
      await user.type(within(dialog).getByLabelText('Credentials'), 'APC');
      await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));

      await waitFor(() =>
        expect(team.invite).toHaveBeenCalledWith({
          email: 'alex@example.com',
          first_name: 'Alex',
          last_name: 'Kim',
          role: 'clinician',
          clinician_access: 'billing',
          is_clinician: true,
          supervisor_id: 2,
          credentials: 'APC',
        }),
      );
      expect(await screen.findByText('Invitation sent to alex@example.com')).toBeInTheDocument();
    });

    it('offers "also sees clients" to a practice manager and hides clinical fields otherwise', async () => {
      const user = userEvent.setup();
      renderTeam(MANAGER);
      await user.click(await screen.findByRole('button', { name: 'Invite' }));
      const dialog = screen.getByRole('dialog', { name: 'Invite a team member' });

      await user.selectOptions(within(dialog).getByLabelText('Role'), 'practice_manager');
      expect(within(dialog).queryByLabelText('Supervisor')).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole('switch', { name: /Also sees clients/ }));
      expect(within(dialog).getByLabelText('Supervisor')).toBeInTheDocument();

      await user.selectOptions(within(dialog).getByLabelText('Role'), 'biller');
      expect(within(dialog).queryByRole('switch', { name: /Also sees clients/ })).not.toBeInTheDocument();
      expect(within(dialog).queryByLabelText('Credentials')).not.toBeInTheDocument();
    });
  });
});
