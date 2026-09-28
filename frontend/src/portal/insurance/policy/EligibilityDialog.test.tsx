import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { eligibilityFixture, renderInsurance, settingsFixture } from '../insurance.fixture';
import { EligibilityDialog } from './EligibilityDialog';

const insurance = vi.hoisted(() => ({ settings: vi.fn(), eligibilityChecks: vi.fn(), checkEligibility: vi.fn() }));

vi.mock('../../../api/insurance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/insurance')>();
  return { ...actual, insuranceApi: { ...actual.insuranceApi, ...insurance } };
});

const INACTIVE = eligibilityFixture({
  id: 40,
  status: 'inactive',
  created_at: '2026-08-01T16:00:00Z',
  checked_by_id: null,
  result: { ...eligibilityFixture().result, errors: ['Coverage terminated'] },
});

function renderDialog() {
  renderInsurance(<EligibilityDialog policyId={3} payerName="Evergreen Health Plan" clientName="Alex Rivera" onClose={vi.fn()} />);
}

describe('eligibility', () => {
  beforeEach(() => {
    insurance.settings.mockReset().mockResolvedValue(settingsFixture());
    insurance.eligibilityChecks.mockReset().mockResolvedValue([eligibilityFixture(), INACTIVE]);
    insurance.checkEligibility.mockReset();
  });

  it('shows the latest answer: coverage, copay, coinsurance and deductible left', async () => {
    renderDialog();
    const result = await screen.findByRole('region', { name: 'Eligibility result' });
    expect(within(result).getByText('Active coverage')).toBeInTheDocument();
    expect(within(result).getByText('$30.00')).toBeInTheDocument();
    expect(within(result).getByText('20% paid by the client')).toBeInTheDocument();
    expect(within(result).getByText('$450.00 left of $1,000.00')).toBeInTheDocument();
    expect(insurance.eligibilityChecks).toHaveBeenCalledWith(3);
  });

  it('lets you look at past checks, including what the payer reported', async () => {
    const user = userEvent.setup();
    renderDialog();
    const history = await screen.findByRole('region', { name: 'Past checks' });
    await user.click(within(history).getByRole('button', { name: /Inactive coverage/ }));
    const result = screen.getByRole('region', { name: 'Eligibility result' });
    expect(within(result).getByText(/\(automatic\)/)).toBeInTheDocument();
    expect(within(result).getByText('Coverage terminated')).toBeInTheDocument();
  });

  it('runs a new check and shows it', async () => {
    const user = userEvent.setup();
    insurance.checkEligibility.mockResolvedValue(
      eligibilityFixture({ id: 42, result: { ...eligibilityFixture().result, copay_cents: 2500 } }),
    );
    renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Check eligibility now' }));
    await waitFor(() => expect(insurance.checkEligibility).toHaveBeenCalledWith(3));
    const result = screen.getByRole('region', { name: 'Eligibility result' });
    expect(await within(result).findByText('$25.00')).toBeInTheDocument();
  });

  it('explains what setup a check needs', async () => {
    const user = userEvent.setup();
    insurance.checkEligibility.mockRejectedValue(new ApiError(422, 'Add the member ID to the policy first.'));
    renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Check eligibility now' }));
    expect(await screen.findByText('Add the member ID to the policy first.')).toBeInTheDocument();
  });

  it('needs a clearinghouse to check', async () => {
    insurance.settings.mockResolvedValue(settingsFixture({ clearinghouse_enabled: false }));
    insurance.eligibilityChecks.mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByText(/Eligibility checks need a clearinghouse/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check eligibility now' })).toBeDisabled();
    expect(screen.getByText('No eligibility checks yet')).toBeInTheDocument();
  });
});
