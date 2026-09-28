import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimListParams, ClaimStatusSummary } from '../../../api/claims';
import { page } from '../../../test/page';
import { claimSummary, renderInsurance, settingsFixture } from '../insurance.fixture';
import { ClaimsList } from './ClaimsList';

const claims = vi.hoisted(() => ({ list: vi.fn(), summary: vi.fn() }));
const insurance = vi.hoisted(() => ({ settings: vi.fn() }));

vi.mock('../../../api/claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/claims')>();
  return { ...actual, claimsApi: { ...actual.claimsApi, ...claims } };
});
vi.mock('../../../api/insurance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/insurance')>();
  return { ...actual, insuranceApi: { ...actual.insuranceApi, ...insurance } };
});

const CLAIMS = [
  claimSummary({ id: 1, patient_control_number: 'SYN1', status: 'draft', total_charge_cents: 15000, insurance_balance_cents: 15000 }),
  claimSummary({ id: 2, patient_control_number: 'SYN2', status: 'rejected', total_charge_cents: 15000, insurance_balance_cents: 15000 }),
  claimSummary({
    id: 3,
    patient_control_number: 'SYN3',
    status: 'paid',
    total_charge_cents: 30000,
    paid_cents: 20000,
    insurance_balance_cents: 0,
  }),
  claimSummary({ id: 4, patient_control_number: 'SYN4', status: 'void', total_charge_cents: 99900, insurance_balance_cents: 0 }),
];

/** What the summary endpoint reports for these claims, one row per status. */
function summaryOf(rows: typeof CLAIMS): ClaimStatusSummary[] {
  const byStatus = new Map<string, ClaimStatusSummary>();
  for (const claim of rows) {
    const row = byStatus.get(claim.status) ?? {
      status: claim.status,
      claims: 0,
      charged_cents: 0,
      paid_cents: 0,
      patient_responsibility_cents: 0,
      insurance_balance_cents: 0,
    };
    row.claims += 1;
    row.charged_cents += claim.total_charge_cents;
    row.paid_cents += claim.paid_cents;
    row.patient_responsibility_cents += claim.patient_responsibility_cents;
    row.insurance_balance_cents += claim.insurance_balance_cents;
    byStatus.set(claim.status, row);
  }
  return [...byStatus.values()];
}

function totals() {
  return within(screen.getByLabelText('Claim totals'));
}

describe('claims by status', () => {
  beforeEach(() => {
    claims.list
      .mockReset()
      .mockImplementation((params: ClaimListParams = {}) =>
        Promise.resolve(page(CLAIMS.filter((claim) => params.status === undefined || claim.status === params.status))),
      );
    claims.summary.mockReset().mockResolvedValue(summaryOf(CLAIMS));
    insurance.settings.mockReset().mockResolvedValue(settingsFixture());
  });

  it('counts claims by status and totals them without void claims', async () => {
    renderInsurance(<ClaimsList filters={{ client_id: 5 }} status="all" onStatusChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'All 4' })).toHaveAttribute('aria-pressed', 'true');
    expect(claims.list).toHaveBeenCalledWith({ client_id: 5, status: undefined, limit: 50, offset: 0 });
    expect(claims.summary).toHaveBeenCalledWith({ client_id: 5 });
    expect(screen.getByRole('button', { name: 'Rejected 1' })).toBeInTheDocument();
    expect(totals().getByText('$600.00')).toBeInTheDocument();
    expect(totals().getByText('$200.00')).toBeInTheDocument();
    expect(totals().getByText('$300.00')).toBeInTheDocument();
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    renderInsurance(<ClaimsList filters={{}} status="paid" onStatusChange={onStatusChange} />);
    expect(await screen.findByRole('link', { name: 'SYN3' })).toBeInTheDocument();
    expect(claims.list).toHaveBeenCalledWith({ status: 'paid', limit: 50, offset: 0 });
    expect(screen.queryByRole('link', { name: 'SYN1' })).not.toBeInTheDocument();
    expect(totals().getByText('$300.00')).toBeInTheDocument();
    expect(screen.getByText('Processed with payment.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Draft 1' }));
    expect(onStatusChange).toHaveBeenCalledWith('draft');
  });

  it('submits only draft and rejected claims in bulk', async () => {
    const user = userEvent.setup();
    renderInsurance(<ClaimsList filters={{}} status="all" onStatusChange={vi.fn()} />);
    await screen.findByRole('link', { name: 'SYN1' });
    expect(screen.queryByRole('checkbox', { name: 'Select claim SYN3' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit selected' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select all draft and rejected claims' }));
    await user.click(screen.getByRole('button', { name: 'Submit 2 selected' }));
    expect(await screen.findByRole('dialog', { name: 'Submit 2 claims' })).toBeInTheDocument();
  });
});
