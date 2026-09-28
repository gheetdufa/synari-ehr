import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { claimFixture, renderInsurance } from '../insurance.fixture';
import ClaimDetailPage from './ClaimDetailPage';

const claims = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), validate: vi.fn(), correct: vi.fn() }));
const team = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../../api/claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/claims')>();
  return { ...actual, claimsApi: { ...actual.claimsApi, ...claims } };
});
vi.mock('../../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, ...team } };
});

const ROUTE = '/portal/billing/claims/:claimId';

function renderClaim() {
  return renderInsurance(<ClaimDetailPage />, { path: '/portal/billing/claims/11', route: ROUTE });
}

describe('claim page', () => {
  beforeEach(() => {
    Object.values(claims).forEach((mock) => mock.mockReset());
    team.list.mockReset().mockResolvedValue([]);
  });

  it('lists what to fix on a draft, with links to where to fix it', async () => {
    claims.get.mockResolvedValue(
      claimFixture({
        issues: [
          { code: 'payer_id_missing', field: 'payer.payer_id', message: "Add Evergreen Health Plan's payer ID in the payer list." },
          { code: 'tax_id_missing', field: 'billing_provider.tax_id', message: "Add the practice's tax ID (EIN or SSN)." },
          { code: 'procedure_code_invalid', field: 'claim.lines[0].procedure_code', message: "Line 1's service code isn't valid." },
        ],
      }),
    );
    renderClaim();

    const problems = await screen.findByRole('list', { name: 'Claim problems' });
    expect(screen.getByText('3 problems to fix before submitting')).toBeInTheDocument();
    const items = within(problems).getAllByRole('listitem');
    expect(within(items[0]).getByRole('link', { name: /Payer list/ })).toHaveAttribute('href', '/portal/settings?tab=insurance');
    expect(within(items[1]).getByRole('link', { name: /Practice billing details/ })).toHaveAttribute(
      'href',
      '/portal/settings?tab=practice',
    );
    expect(within(items[2]).getByRole('link', { name: /Edit below/ })).toHaveAttribute('href', '#claim-lines');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Correct' })).not.toBeInTheDocument();
  });

  it('says a clean draft is ready and saves an edited diagnosis order', async () => {
    const user = userEvent.setup();
    const claim = claimFixture();
    claims.get.mockResolvedValue(claim);
    claims.update.mockResolvedValue(claimFixture({ diagnosis_codes: ['F331', 'F411'] }));
    renderClaim();

    expect(await screen.findByText('Ready to submit.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move F33.1 up' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(claims.update).toHaveBeenCalledWith(11, {
        diagnosis_codes: ['F331', 'F411'],
        lines: [
          { id: 101, diagnosis_pointers: [2, 1] },
          { id: 102, diagnosis_pointers: [2] },
        ],
      }),
    );
    expect(await screen.findByText('Claim saved')).toBeInTheDocument();
  });

  it('shows what the payer paid on a paid claim, and offers correction and a secondary claim', async () => {
    claims.get.mockResolvedValue(
      claimFixture({
        status: 'paid',
        paid_cents: 20000,
        adjustment_cents: 6000,
        patient_responsibility_cents: 4000,
        insurance_balance_cents: 0,
        submitted_at: '2026-09-12T16:00:00Z',
        submission_method: 'x12_file',
        issues: [{ code: 'required', field: 'payer.payer_id', message: 'Not shown for claims the payer has.' }],
      }),
    );
    renderClaim();

    expect(await screen.findByText('Processed with payment.')).toBeInTheDocument();
    expect(screen.getByText('$200.00')).toBeInTheDocument();
    expect(screen.getByText(/837P file/)).toBeInTheDocument();
    expect(screen.queryByText('Not shown for claims the payer has.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Correct' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create secondary claim' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Edit claim' })).not.toBeInTheDocument();
  });

  it('opens the corrected claim after confirming', async () => {
    const user = userEvent.setup();
    claims.get.mockResolvedValue(claimFixture({ status: 'accepted' }));
    claims.correct.mockResolvedValue(claimFixture({ id: 15, patient_control_number: 'SYN00DX15', frequency_code: '7' }));
    renderClaim();

    await user.click(await screen.findByRole('button', { name: 'Correct' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create corrected claim' }));
    await waitFor(() => expect(claims.correct).toHaveBeenCalledWith(11));
    expect(await screen.findByText('Corrected claim SYN00DX15 created as a draft')).toBeInTheDocument();
  });

  it('shows a friendly error for a claim out of reach', async () => {
    claims.get.mockRejectedValue(new ApiError(404, 'Claim not found'));
    renderClaim();
    expect(await screen.findByText('Claim not found')).toBeInTheDocument();
  });
});
