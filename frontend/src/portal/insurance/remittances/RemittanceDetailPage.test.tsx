import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLINICIAN_BILLING_OWN,
  claimSummary,
  paymentFixture,
  remittanceFixture,
  renderInsurance,
} from '../insurance.fixture';
import { page } from '../../../test/page';
import RemittanceDetailPage from './RemittanceDetailPage';

const remittances = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const claims = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../../api/remittances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/remittances')>();
  return { ...actual, remittancesApi: { ...actual.remittancesApi, ...remittances } };
});
vi.mock('../../../api/claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/claims')>();
  return { ...actual, claimsApi: { ...actual.claimsApi, ...claims } };
});

const ROUTE = '/portal/billing/remittances/:remittanceId';

const NEEDS_REVIEW = remittanceFixture({
  claim_count: 2,
  unmatched_count: 1,
  total_paid_cents: 20000,
  claims: [
    paymentFixture({ id: 31, claim_id: 11 }),
    paymentFixture({ id: 32, claim_id: null, client_id: null, client_name: '', patient_control_number: 'SYN9999' }),
  ],
});

describe('insurance payment', () => {
  beforeEach(() => {
    remittances.get.mockReset().mockResolvedValue(NEEDS_REVIEW);
    remittances.post.mockReset();
    claims.list.mockReset().mockResolvedValue(
      page([
        claimSummary({ id: 11, status: 'accepted', total_charge_cents: 30000 }),
        claimSummary({ id: 12, status: 'submitted', patient_control_number: 'SYN00DX12', client_name: 'Sam Okafor', total_charge_cents: 15000 }),
        claimSummary({ id: 13, status: 'draft', patient_control_number: 'SYN00DX13', total_charge_cents: 15000 }),
      ]),
    );
  });

  it('shows each claim payment with its adjustments explained', async () => {
    renderInsurance(<RemittanceDetailPage />, { path: '/portal/billing/remittances/21', route: ROUTE });
    expect(await screen.findByText('This payment needs review')).toBeInTheDocument();
    expect(screen.getAllByText('CO-45')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Contractual obligation: above the fee schedule or contracted rate')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Patient responsibility: coinsurance')[0]).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View claim' })).toHaveAttribute('href', '/portal/billing/claims/11');
    expect(screen.getByText('Unmatched')).toBeInTheDocument();
  });

  it('matches an unmatched payment to a claim, then posts', async () => {
    const user = userEvent.setup();
    remittances.post.mockResolvedValue({ ...NEEDS_REVIEW, status: 'posted', posted_at: '2026-09-26T10:00:00Z' });
    renderInsurance(<RemittanceDetailPage />, { path: '/portal/billing/remittances/21', route: ROUTE });

    const picker = await screen.findByRole('combobox', { name: 'Match to a claim' });
    await waitFor(() => expect(claims.list).toHaveBeenCalledWith({ payer_id: 2, limit: 200 }));
    const suggested = within(picker).getByRole('group', { name: 'Same amount billed' });
    expect(within(suggested).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'SYN00DX12 · Sam Okafor · Sep 3, 2026 – Sep 10, 2026 · $150.00 · Submitted',
    ]);
    await user.selectOptions(picker, '12');
    await user.click(screen.getByRole('button', { name: 'Post payment' }));
    const dialog = screen.getByRole('dialog', { name: 'Post this payment?' });
    await user.click(within(dialog).getByRole('button', { name: 'Post payment' }));

    await waitFor(() => expect(remittances.post).toHaveBeenCalledWith(21, [{ remittance_claim_id: 32, claim_id: 12 }]));
    expect(await screen.findByText('Payment posted')).toBeInTheDocument();
  });

  it('warns that payments left unmatched stay unposted', async () => {
    const user = userEvent.setup();
    renderInsurance(<RemittanceDetailPage />, { path: '/portal/billing/remittances/21', route: ROUTE });
    await user.click(await screen.findByRole('button', { name: 'Post payment' }));
    expect(within(screen.getByRole('dialog')).getByText(/1 payment stays unmatched/)).toBeInTheDocument();
  });

  it('has nothing to post once posted', async () => {
    remittances.get.mockResolvedValue(remittanceFixture({ status: 'posted', posted_at: '2026-09-26T10:00:00Z' }));
    renderInsurance(<RemittanceDetailPage />, { path: '/portal/billing/remittances/21', route: ROUTE });
    expect(await screen.findByRole('heading', { name: 'EVERGREEN HEALTH PLAN · $100.00' })).toBeInTheDocument();
    expect(screen.queryByText('This payment needs review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('is only for people with practice-wide billing', async () => {
    renderInsurance(<RemittanceDetailPage />, {
      path: '/portal/billing/remittances/21',
      route: ROUTE,
      session: CLINICIAN_BILLING_OWN,
    });
    expect(screen.getByText('Not available for your role')).toBeInTheDocument();
    expect(remittances.get).not.toHaveBeenCalled();
  });
});
