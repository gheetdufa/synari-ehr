import { describe, expect, it } from 'vitest';
import { eligibilityFixture } from '../insurance.fixture';
import { authorizationInput } from './AuthorizationsDialog';
import { NOT_STATED, eligibilityHeadline, eligibilityRows } from './eligibility';

describe('eligibility results', () => {
  it('shows the benefits the payer stated and marks the rest', () => {
    const rows = Object.fromEntries(eligibilityRows(eligibilityFixture().result).map((row) => [row.label, row.value]));
    expect(rows).toEqual({
      Plan: 'Evergreen PPO, group GRP100',
      Coverage: 'Since Jan 1, 2026',
      'In network': 'Yes',
      Copay: '$30.00',
      Coinsurance: '20% paid by the client',
      Deductible: '$450.00 left of $1,000.00',
      'Out-of-pocket maximum': NOT_STATED,
      'Prior authorization': 'Not required',
    });
  });

  it('summarizes a past check in one line', () => {
    expect(eligibilityHeadline(eligibilityFixture().result)).toBe('Copay $30.00 · Coinsurance 20% · Deductible $450.00 left');
    const silent = eligibilityFixture().result;
    expect(eligibilityHeadline({ ...silent, copay_cents: null, coinsurance_percent: null, deductible_remaining_cents: null })).toBe(
      '',
    );
  });
});

describe('prior authorization form', () => {
  const valid = { number: ' AUTH-1 ', start_date: '2026-09-01', end_date: '2026-12-31', visits_authorized: '12', notes: '' };

  it('builds the API input', () => {
    expect(authorizationInput(valid)).toEqual({
      input: { number: 'AUTH-1', start_date: '2026-09-01', end_date: '2026-12-31', visits_authorized: 12, notes: '' },
      errors: {},
    });
    expect(authorizationInput({ ...valid, visits_authorized: '' }).input?.visits_authorized).toBeNull();
  });

  it('explains what is missing or out of order', () => {
    expect(authorizationInput({ ...valid, number: '', end_date: '2026-08-01', visits_authorized: '2.5' }).errors).toEqual({
      number: 'Enter the authorization number',
      end_date: 'The end date must be on or after the start date',
      visits_authorized: 'Enter a whole number of visits',
    });
  });
});
