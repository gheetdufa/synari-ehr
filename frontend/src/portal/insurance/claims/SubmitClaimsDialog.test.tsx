import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { claimSummary, renderInsurance, settingsFixture } from '../insurance.fixture';
import { SubmitClaimsDialog } from './SubmitClaimsDialog';

const claims = vi.hoisted(() => ({ submit: vi.fn() }));
const insurance = vi.hoisted(() => ({ settings: vi.fn() }));

vi.mock('../../../api/claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/claims')>();
  return { ...actual, claimsApi: { ...actual.claimsApi, ...claims } };
});
vi.mock('../../../api/insurance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/insurance')>();
  return { ...actual, insuranceApi: { ...actual.insuranceApi, ...insurance } };
});

describe('submitting claims', () => {
  beforeEach(() => {
    claims.submit.mockReset();
    insurance.settings.mockReset();
  });

  it('queues claims with the clearinghouse when one is connected', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    insurance.settings.mockResolvedValue(settingsFixture());
    claims.submit.mockResolvedValue([claimSummary({ status: 'queued' })]);
    renderInsurance(<SubmitClaimsDialog claimIds={[11, 12]} onClose={onClose} />);

    expect(await screen.findByRole('radio', { name: /Send through the clearinghouse/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(claims.submit).toHaveBeenCalledWith([11, 12], 'stedi');
    expect(screen.getByText('2 claims queued for the clearinghouse')).toBeInTheDocument();
  });

  it('downloads an 837P file when chosen', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    insurance.settings.mockResolvedValue(settingsFixture({ x12_submitter_id: 'LEE01', x12_receiver_id: 'OA' }));
    claims.submit.mockResolvedValue(null);
    renderInsurance(<SubmitClaimsDialog claimIds={[11]} onClose={onClose} />);

    await user.click(await screen.findByRole('radio', { name: /Download an 837P file/ }));
    await user.click(screen.getByRole('button', { name: 'Download 837P' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(claims.submit).toHaveBeenCalledWith([11], 'x12_file');
    expect(screen.getByText('837P file downloaded. Upload it to your clearinghouse.')).toBeInTheDocument();
  });

  it('only offers paper without a clearinghouse or 837P envelope IDs', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    insurance.settings.mockResolvedValue(settingsFixture({ clearinghouse_enabled: false }));
    claims.submit.mockResolvedValue(null);
    renderInsurance(<SubmitClaimsDialog claimIds={[11]} onClose={onClose} />);

    expect(await screen.findByRole('radio', { name: /Send through the clearinghouse/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Download an 837P file/ })).toBeDisabled();
    expect(screen.getByText(/No clearinghouse is connected/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Print CMS-1500 forms/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Download CMS-1500' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(claims.submit).toHaveBeenCalledWith([11], 'paper');
  });

  it('shows each claim’s problems when the API refuses, and submits nothing', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    insurance.settings.mockResolvedValue(settingsFixture());
    claims.submit.mockRejectedValue(
      new ApiError(422, {
        message: 'Fix these claims before submitting them.',
        claims: [
          {
            claim_id: 12,
            patient_control_number: 'SYN00DX12',
            issues: [{ code: 'member_id_missing', field: 'subscriber.member_id', message: "Add the member ID to Sam Okafor's policy." }],
          },
        ],
      }),
    );
    renderInsurance(<SubmitClaimsDialog claimIds={[11, 12]} onClose={onClose} />);

    await user.click(await screen.findByRole('button', { name: 'Submit' }));
    const problems = await screen.findByRole('alert');
    expect(within(problems).getByRole('link', { name: 'Claim SYN00DX12' })).toHaveAttribute('href', '/portal/billing/claims/12');
    expect(within(problems).getByText("Add the member ID to Sam Okafor's policy.")).toBeInTheDocument();
    expect(within(problems).getByText('Nothing was submitted.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
