import { describe, expect, it } from 'vitest';
import type { ClaimIssue } from '../../api/claims';
import { claimFixture } from './insurance.fixture';
import { issueFix, type IssueContext } from './issueFixes';

function context(changes: Partial<IssueContext> = {}): IssueContext {
  return {
    claim: claimFixture({
      rendering_clinician_id: 2,
      rendering_clinician_name: 'Jordan Park, LMFT',
      supervising_clinician_id: 1,
      supervising_clinician_name: 'Dana Lee, LCSW',
    }),
    editable: true,
    selfId: 1,
    billingProvider: 'individual',
    ...changes,
  };
}

function issue(field: string, code = 'required'): ClaimIssue {
  return { code, field, message: 'Something is missing.' };
}

describe('where to fix a claim problem', () => {
  it.each<[string, ClaimIssue, Partial<IssueContext>, ReturnType<typeof issueFix>]>([
    ['the practice tax ID', issue('billing_provider.tax_id'), {}, { label: 'Practice billing details', to: '/portal/settings?tab=practice' }],
    [
      "an individual practice's billing NPI (the rendering clinician's)",
      issue('billing_provider.npi', 'npi_missing'),
      {},
      { label: 'Jordan Park, LMFT in Team settings', to: '/portal/settings?tab=team' },
    ],
    [
      "a group practice's billing NPI",
      issue('billing_provider.npi', 'npi_missing'),
      { billingProvider: 'organization' },
      { label: 'Practice billing details', to: '/portal/settings?tab=practice' },
    ],
    [
      'the signed-in clinician’s own taxonomy',
      issue('claim.rendering_provider.taxonomy', 'taxonomy_missing'),
      { selfId: 2 },
      { label: 'Your profile', to: '/portal/settings?tab=profile' },
    ],
    [
      "the supervisor's NPI",
      issue('claim.supervising_provider.npi', 'npi_missing'),
      {},
      { label: 'Your profile', to: '/portal/settings?tab=profile' },
    ],
    ['the payer ID', issue('payer.payer_id', 'payer_id_missing'), {}, { label: 'Payer list', to: '/portal/settings?tab=insurance' }],
    [
      'the member ID',
      issue('subscriber.member_id', 'member_id_missing'),
      {},
      { label: "Alex Rivera's record", to: '/portal/clients/5' },
    ],
    ['an inactive policy', issue('policy', 'policy_inactive'), {}, { label: "Alex Rivera's record", to: '/portal/clients/5' }],
    ['diagnoses on a draft', issue('claim.diagnoses', 'diagnosis_count'), {}, { label: 'Edit below', anchor: 'claim-diagnoses' }],
    [
      'diagnoses on a claim that can’t be edited',
      issue('claim.diagnoses', 'diagnosis_count'),
      { editable: false },
      { label: "Alex Rivera's diagnoses", to: '/portal/clients/5' },
    ],
    [
      'a session no longer attended',
      issue('claim.lines[1]', 'session_not_billable'),
      {},
      { label: 'Open the session', to: '/portal/calendar?appointment=80' },
    ],
    ['a line code', issue('claim.lines[0].procedure_code', 'procedure_code_invalid'), {}, { label: 'Edit below', anchor: 'claim-lines' }],
    ['the place of service', issue('claim.place_of_service', 'place_of_service_invalid'), {}, { label: 'Edit below', anchor: 'claim-details' }],
    ['a missing rendering clinician', issue('claim.rendering_provider', 'rendering_provider_required'), {}, { label: 'Edit below', anchor: 'claim-details' }],
    ['the service location', issue('claim.service_facility.address.postal_code'), {}, { label: 'Locations', to: '/portal/settings?tab=locations' }],
  ])('%s', (_case, problem, changes, expected) => {
    expect(issueFix(problem, context(changes))).toEqual(expected);
  });

  it('points secondary-claim problems at the primary claim', () => {
    const secondary = context({ claim: { ...context().claim, primary_claim_id: 9 } });
    expect(issueFix(issue('claim.other_payer', 'other_payer_required'), secondary)).toEqual({
      label: 'Primary claim',
      to: '/portal/billing/claims/9',
    });
    expect(issueFix(issue('claim.other_payer', 'other_payer_required'), context())).toBeNull();
  });
});
