import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/auth';
import type { ClientDetail } from '../../api/clients';
import type { TeamMember } from '../../api/team';
import { ROLE_SESSIONS, testClient } from '../../test/clients';
import { WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { CareTeamSection } from './CareTeamSection';

const mocks = vi.hoisted(() => ({ setCareTeam: vi.fn(), team: vi.fn() }));

vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, setCareTeam: mocks.setCareTeam } };
});
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, list: mocks.team } };
});

function member(id: number, displayName: string, changes: Partial<TeamMember> = {}): TeamMember {
  const [first_name, last_name] = displayName.split(/[ ,]+/);
  return {
    id,
    email: `${first_name.toLowerCase()}@example.com`,
    first_name,
    last_name,
    display_name: displayName,
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

const TEAM = [
  member(1, 'Dana Lee, LCSW', { role: 'owner' }),
  member(2, 'Sam Ortiz, LPC'),
  member(3, 'Jo Park, LMFT'),
  member(5, 'Robin Hale', { role: 'scheduler', is_clinician: false }),
  member(8, 'Lee Gone, LPC', { status: 'deactivated' }),
];

// Dana (1) is Alex's primary clinician and Sam (2) is also on the care team.
const alex = testClient({
  care_team: [
    { staff_id: 1, name: 'Dana Lee, LCSW', is_primary: true },
    { staff_id: 2, name: 'Sam Ortiz, LPC', is_primary: false },
  ],
});

function renderSection(session: Session, client: ClientDetail = alex) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <CareTeamSection client={client} />
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('CareTeamSection', () => {
  beforeEach(() => {
    mocks.setCareTeam.mockReset();
    mocks.team.mockReset();
    mocks.team.mockResolvedValue(TEAM);
  });

  it('lists the care team with the primary clinician marked', () => {
    renderSection(ROLE_SESSIONS.clinician);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Dana Lee, LCSWPrimary', 'Sam Ortiz, LPC']);
  });

  it.each([
    ['the primary clinician', ROLE_SESSIONS.owner, true],
    ['a scheduler', ROLE_SESSIONS.scheduler, true],
    ['another clinician on the team', ROLE_SESSIONS.clinician, false],
    ['a biller', ROLE_SESSIONS.biller, false],
  ])('%s may edit it: %s', (_who, session, allowed) => {
    renderSection(session);
    expect(Boolean(screen.queryByRole('button', { name: 'Edit care team' }))).toBe(allowed);
  });

  it('changes the primary clinician and team from active clinicians', async () => {
    mocks.setCareTeam.mockImplementation((_id: number, input: { primary_clinician_id: number }) =>
      Promise.resolve({ ...alex, care_team: [{ staff_id: input.primary_clinician_id, name: 'Jo Park, LMFT', is_primary: true }] }),
    );
    const user = userEvent.setup();
    renderSection(ROLE_SESSIONS.scheduler);

    await user.click(screen.getByRole('button', { name: 'Edit care team' }));
    const dialog = await screen.findByRole('dialog');
    const primary = await within(dialog).findByRole('combobox', { name: /primary clinician/i });
    expect(within(primary).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose a clinician',
      'Dana Lee, LCSW',
      'Sam Ortiz, LPC',
      'Jo Park, LMFT',
    ]);
    expect(within(dialog).getByRole('checkbox', { name: 'Sam Ortiz, LPC' })).toBeChecked();

    await user.selectOptions(primary, '3');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Dana Lee, LCSW' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Sam Ortiz, LPC' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save care team' }));

    await waitFor(() => expect(mocks.setCareTeam).toHaveBeenCalledWith(7, { primary_clinician_id: 3, clinician_ids: [1] }));
    expect(await screen.findByText('Care team updated')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('warns a primary clinician who removes themselves', async () => {
    const user = userEvent.setup();
    const samsClient = testClient({ care_team: [{ staff_id: 2, name: 'Sam Ortiz, LPC', is_primary: true }] });
    renderSection(ROLE_SESSIONS.clinician, samsClient);

    await user.click(screen.getByRole('button', { name: 'Edit care team' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(await within(dialog).findByRole('combobox', { name: /primary clinician/i }), '3');
    expect(within(dialog).getByText(/you may no longer be able to open this chart/i)).toBeInTheDocument();
  });
});
