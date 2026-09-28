import { describe, expect, it } from 'vitest';
import { claimSummary, paymentFixture, remittanceFixture } from '../insurance.fixture';
import { adjustmentText, candidateLabel, claimCandidates, unmatchedPayments } from './matching';

describe('matching insurance payments to claims', () => {
  it('suggests sent claims billed for the same amount first', () => {
    const claims = [
      claimSummary({ id: 1, status: 'submitted', total_charge_cents: 15000 }),
      claimSummary({ id: 2, status: 'accepted', total_charge_cents: 30000 }),
      claimSummary({ id: 3, status: 'draft', total_charge_cents: 15000 }),
      claimSummary({ id: 4, status: 'void', total_charge_cents: 15000 }),
      claimSummary({ id: 5, status: 'paid', total_charge_cents: 15000 }),
    ];
    const { suggested, others } = claimCandidates(claims, paymentFixture({ charge_cents: 15000 }));
    expect(suggested.map((claim) => claim.id)).toEqual([1, 5]);
    expect(others.map((claim) => claim.id)).toEqual([2]);
  });

  it('describes candidates and adjustments in words', () => {
    expect(candidateLabel(claimSummary({ status: 'submitted' }))).toBe(
      'SYN00DX11 · Alex Rivera · Sep 3, 2026 – Sep 10, 2026 · $300.00 · Submitted',
    );
    expect(adjustmentText({ group_code: 'CO', reason_code: '45', amount_cents: 3000, quantity: 0 })).toEqual({
      code: 'CO-45',
      meaning: 'Contractual obligation: above the fee schedule or contracted rate',
    });
    expect(adjustmentText({ group_code: 'PR', reason_code: '999', amount_cents: 100, quantity: 0 })).toEqual({
      code: 'PR-999',
      meaning: 'Patient responsibility',
    });
  });

  it('lists only unposted payments without a claim', () => {
    const remittance = remittanceFixture({
      claims: [
        paymentFixture({ id: 1 }),
        paymentFixture({ id: 2, claim_id: null }),
        paymentFixture({ id: 3, claim_id: null, posted_at: '2026-09-25T18:00:00Z' }),
      ],
    });
    expect(unmatchedPayments(remittance).map((payment) => payment.id)).toEqual([2]);
  });
});
