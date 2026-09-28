import type { ClaimDetail, ClaimIssue } from '../../api/claims';
import type { BillingProvider } from '../../api/practice';

/** Where to fix a claim problem: another screen (`to`) or a section of the claim page (`anchor`). */
export interface IssueFix {
  label: string;
  to?: string;
  anchor?: string;
}

export interface IssueContext {
  claim: Pick<
    ClaimDetail,
    | 'client_id'
    | 'client_name'
    | 'rendering_clinician_id'
    | 'rendering_clinician_name'
    | 'supervising_clinician_id'
    | 'supervising_clinician_name'
    | 'primary_claim_id'
    | 'lines'
  >;
  /** Whether the claim itself can be edited on this page (drafts and rejected claims). */
  editable: boolean;
  /** The signed-in staff member, whose own details live under "My profile". */
  selfId: number;
  /** Individual practices bill under the rendering clinician's NPI and taxonomy. */
  billingProvider: BillingProvider;
}

export const CLAIM_SECTIONS = {
  details: 'claim-details',
  diagnoses: 'claim-diagnoses',
  lines: 'claim-lines',
} as const;

const PRACTICE: IssueFix = { label: 'Practice billing details', to: '/portal/settings?tab=practice' };
const PAYERS: IssueFix = { label: 'Payer list', to: '/portal/settings?tab=insurance' };
const LOCATIONS: IssueFix = { label: 'Locations', to: '/portal/settings?tab=locations' };

function clinicianFix(context: IssueContext, clinicianId: number | null, name: string): IssueFix {
  if (clinicianId === context.selfId) return { label: 'Your profile', to: '/portal/settings?tab=profile' };
  return { label: name ? `${name} in Team settings` : 'Team settings', to: '/portal/settings?tab=team' };
}

function onPage(context: IssueContext, anchor: string): IssueFix | null {
  return context.editable ? { label: 'Edit below', anchor } : null;
}

const LINE_FIELD = /^claim\.lines\[(\d+)\]/;

/**
 * Where to go to fix a claim problem, from the issue's field path (see the API's
 * claims/validate.py). Null when there's nothing to link to.
 */
export function issueFix(issue: ClaimIssue, context: IssueContext): IssueFix | null {
  const { field, code } = issue;
  const { claim } = context;
  const rendering = () => clinicianFix(context, claim.rendering_clinician_id, claim.rendering_clinician_name);

  if (field.startsWith('billing_provider.')) {
    const clinicianField = ['billing_provider.npi', 'billing_provider.taxonomy', 'billing_provider.person'].some((prefix) =>
      field.startsWith(prefix),
    );
    return clinicianField && context.billingProvider === 'individual' ? rendering() : PRACTICE;
  }
  if (code === 'rendering_provider_required') return onPage(context, CLAIM_SECTIONS.details);
  if (field.startsWith('claim.rendering_provider') || /^claim\.lines\[\d+\]\.rendering_provider/.test(field)) {
    return rendering();
  }
  if (field.startsWith('claim.supervising_provider')) {
    return clinicianFix(context, claim.supervising_clinician_id, claim.supervising_clinician_name);
  }
  if (field.startsWith('claim.service_facility')) return LOCATIONS;
  if (field.startsWith('payer.')) return PAYERS;
  if (field.startsWith('subscriber.') || field === 'policy' || field.startsWith('patient')) {
    return { label: `${claim.client_name || 'Client'}'s record`, to: `/portal/clients/${claim.client_id}` };
  }
  if (field.startsWith('claim.diagnoses')) {
    return (
      onPage(context, CLAIM_SECTIONS.diagnoses) ?? {
        label: `${claim.client_name || 'Client'}'s diagnoses`,
        to: `/portal/clients/${claim.client_id}`,
      }
    );
  }
  if (code === 'session_not_billable') {
    const index = Number(LINE_FIELD.exec(field)?.[1]);
    const appointmentId = claim.lines[index]?.appointment_id;
    return appointmentId ? { label: 'Open the session', to: `/portal/calendar?appointment=${appointmentId}` } : null;
  }
  if (field.startsWith('claim.lines') || field === 'claim.total_charge_cents') return onPage(context, CLAIM_SECTIONS.lines);
  if (field.startsWith('claim.other_payer')) {
    return claim.primary_claim_id ? { label: 'Primary claim', to: `/portal/billing/claims/${claim.primary_claim_id}` } : null;
  }
  if (field.startsWith('claim.')) return onPage(context, CLAIM_SECTIONS.details);
  return null;
}
