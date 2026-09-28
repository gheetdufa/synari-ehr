import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from '../../../test/page';
import { claimSummary, renderInsurance, sessionFixture } from '../insurance.fixture';
import { UnbilledQueue } from './UnbilledQueue';

const claims = vi.hoisted(() => ({ unbilled: vi.fn(), create: vi.fn() }));

vi.mock('../../../api/claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/claims')>();
  return { ...actual, claimsApi: { ...actual.claimsApi, ...claims } };
});

const SESSIONS = [
  sessionFixture({ participant_id: 1, starts_at: '2026-09-03T19:00:00Z' }),
  sessionFixture({ participant_id: 2, starts_at: '2026-09-10T19:00:00Z', note_signed: false }),
  sessionFixture({ participant_id: 3, client_id: 9, client_name: 'Sam Okafor', has_diagnoses: false }),
];

describe('ready to file', () => {
  beforeEach(() => {
    claims.unbilled.mockReset().mockResolvedValue(page(SESSIONS));
    claims.create.mockReset().mockImplementation(({ participant_ids }: { participant_ids: number[] }) =>
      Promise.resolve([claimSummary({ id: participant_ids[0] * 10 })]),
    );
  });

  it('shows sessions by client with what might get them denied', async () => {
    renderInsurance(<UnbilledQueue filters={{ payer_id: 2 }} onCreated={vi.fn()} />);
    expect(await screen.findByText('3 sessions ready to file')).toBeInTheDocument();
    expect(claims.unbilled).toHaveBeenCalledWith({ payer_id: 2, limit: 100, offset: 0 });
    expect(screen.getByText('Note not signed')).toBeInTheDocument();
    expect(screen.getByText('No diagnosis')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create claims' })).toBeDisabled();
  });

  it('creates claims for the chosen sessions without asking when nothing needs attention', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderInsurance(<UnbilledQueue filters={{}} onCreated={onCreated} />);
    await user.click(await screen.findByRole('checkbox', { name: /Select Alex Rivera, Thu, Sep 3/ }));
    expect(screen.getByText('1 of 3 sessions selected · $150.00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create claims' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith([expect.objectContaining({ id: 10 })]));
    expect(claims.create).toHaveBeenCalledWith({ participant_ids: [1] });
    expect(await screen.findByText('Created 1 draft claim')).toBeInTheDocument();
  });

  it('confirms before creating claims for sessions that need attention, one claim request per client', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderInsurance(<UnbilledQueue filters={{}} onCreated={onCreated} />);
    await user.click(await screen.findByRole('checkbox', { name: 'Select all sessions' }));
    await user.click(screen.getByRole('button', { name: 'Create claims' }));

    const dialog = await screen.findByRole('dialog', { name: 'Some sessions need attention' });
    expect(within(dialog).getByText('1 session has no signed note.')).toBeInTheDocument();
    expect(within(dialog).getByText(/1 session is for a client without a diagnosis/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create claims anyway' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(claims.create.mock.calls).toEqual([[{ participant_ids: [1, 2] }], [{ participant_ids: [3] }]]);
    expect(screen.getByText('Created 2 draft claims')).toBeInTheDocument();
  });

  it('loads more sessions and counts every session waiting', async () => {
    const user = userEvent.setup();
    claims.unbilled
      .mockResolvedValueOnce(page(SESSIONS.slice(0, 2), 3))
      .mockResolvedValueOnce(page(SESSIONS.slice(2), 3));
    renderInsurance(<UnbilledQueue filters={{}} onCreated={vi.fn()} />);
    expect(await screen.findByText('3 sessions ready to file')).toBeInTheDocument();
    expect(screen.queryByText('Sam Okafor')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 3 sessions')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Sam Okafor')).toBeInTheDocument();
    expect(claims.unbilled).toHaveBeenLastCalledWith({ limit: 100, offset: 2 });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says so when nothing is waiting', async () => {
    claims.unbilled.mockResolvedValue(page([]));
    renderInsurance(<UnbilledQueue filters={{}} onCreated={vi.fn()} />);
    expect(await screen.findByText('Nothing waiting to be billed')).toBeInTheDocument();
  });
});
