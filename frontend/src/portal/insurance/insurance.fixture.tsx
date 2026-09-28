import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Session } from '../../api/auth';
import type { Claim, ClaimDetail, UnbilledSession } from '../../api/claims';
import type { EligibilityCheck, InsuranceSettings } from '../../api/insurance';
import type { RemittanceClaim, RemittanceDetail } from '../../api/remittances';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';

/** Test data for the insurance screens. Every person and number here is fictional. */

export const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

export function claimFixture(changes: Partial<ClaimDetail> = {}): ClaimDetail {
  return {
    id: 11,
    client_id: 5,
    client_name: 'Alex Rivera',
    policy_id: 3,
    payer_id: 2,
    payer_name: 'Evergreen Health Plan',
    payer_responsibility: 'P',
    status: 'draft',
    submission_method: 'stedi',
    patient_control_number: 'SYN00DX11',
    frequency_code: '1',
    original_claim_id: null,
    primary_claim_id: null,
    payer_claim_number: '',
    rendering_clinician_id: 1,
    rendering_clinician_name: 'Dana Lee, LCSW',
    supervising_clinician_id: null,
    supervising_clinician_name: '',
    place_of_service: '11',
    prior_authorization_number: '',
    diagnosis_codes: ['F411', 'F331'],
    total_charge_cents: 30000,
    paid_cents: 0,
    adjustment_cents: 0,
    patient_responsibility_cents: 0,
    insurance_balance_cents: 30000,
    first_service_date: '2026-09-03',
    last_service_date: '2026-09-10',
    clearinghouse_ref: '',
    submitted_at: null,
    adjudicated_at: null,
    last_error: '',
    created_at: '2026-09-12T15:00:00Z',
    updated_at: '2026-09-12T15:00:00Z',
    lines: [
      {
        id: 101,
        participant_id: 7,
        appointment_id: 70,
        line_control_number: 'SYN00DX11-1',
        service_date: '2026-09-03',
        procedure_code: '90837',
        modifiers: [],
        units: 1,
        charge_cents: 15000,
        place_of_service: '',
        diagnosis_pointers: [1, 2],
        allowed_cents: null,
        paid_cents: 0,
        adjustment_cents: 0,
        patient_responsibility_cents: 0,
      },
      {
        id: 102,
        participant_id: 8,
        appointment_id: 80,
        line_control_number: 'SYN00DX11-2',
        service_date: '2026-09-10',
        procedure_code: '90837',
        modifiers: ['95'],
        units: 1,
        charge_cents: 15000,
        place_of_service: '10',
        diagnosis_pointers: [1],
        allowed_cents: null,
        paid_cents: 0,
        adjustment_cents: 0,
        patient_responsibility_cents: 0,
      },
    ],
    events: [
      {
        id: 1,
        kind: 'created',
        message: 'Claim created',
        data: null,
        staff_id: 1,
        created_at: '2026-09-12T15:00:00Z',
      },
    ],
    issues: [],
    diagnoses: [
      { code: 'F411', description: 'Generalized anxiety disorder' },
      { code: 'F331', description: 'Major depressive disorder, recurrent, moderate' },
    ],
    ...changes,
  };
}

/** A claim as the list endpoint returns it (no lines or history). */
export function claimSummary(changes: Partial<Claim> = {}): Claim {
  const detailOnly = ['lines', 'events', 'issues', 'diagnoses'];
  const summary = Object.fromEntries(Object.entries(claimFixture()).filter(([key]) => !detailOnly.includes(key)));
  return { ...(summary as unknown as Claim), ...changes };
}

export function sessionFixture(changes: Partial<UnbilledSession> = {}): UnbilledSession {
  return {
    participant_id: 7,
    appointment_id: 70,
    client_id: 5,
    client_name: 'Alex Rivera',
    clinician_id: 1,
    clinician_name: 'Dana Lee, LCSW',
    starts_at: '2026-09-03T19:00:00Z',
    service_date: '2026-09-03',
    service_code: '90837',
    service_description: 'Psychotherapy, 60 minutes',
    fee_cents: 15000,
    location_type: 'in_person',
    policy_id: 3,
    payer_id: 2,
    payer_name: 'Evergreen Health Plan',
    note_signed: true,
    has_diagnoses: true,
    eligibility_status: 'active',
    ...changes,
  };
}

export function settingsFixture(changes: Partial<InsuranceSettings> = {}): InsuranceSettings {
  return {
    telehealth_modifier: '95',
    supervised_billing: 'supervisor_renders',
    x12_submitter_id: '',
    x12_receiver_id: '',
    x12_receiver_name: '',
    eligibility_auto_check: false,
    clearinghouse_enabled: true,
    clearinghouse_usage: 'T',
    ...changes,
  };
}

export function paymentFixture(changes: Partial<RemittanceClaim> = {}): RemittanceClaim {
  return {
    id: 31,
    claim_id: 11,
    client_id: 5,
    client_name: 'Alex Rivera',
    patient_control_number: 'SYN00DX11',
    status_code: '1',
    status_description: 'Processed as primary',
    charge_cents: 15000,
    paid_cents: 10000,
    patient_responsibility_cents: 2000,
    payer_claim_number: 'EVG-778',
    adjustments: [],
    lines: [
      {
        procedure_code: '90837',
        modifiers: [],
        units: 1,
        line_control_number: 'SYN00DX11-1',
        service_date: '2026-09-03',
        charge_cents: 15000,
        paid_cents: 10000,
        allowed_cents: 12000,
        adjustments: [
          { group_code: 'CO', reason_code: '45', amount_cents: 3000, quantity: 0 },
          { group_code: 'PR', reason_code: '2', amount_cents: 2000, quantity: 0 },
        ],
        remark_codes: [],
      },
    ],
    posted_at: null,
    ...changes,
  };
}

export function remittanceFixture(changes: Partial<RemittanceDetail> = {}): RemittanceDetail {
  return {
    id: 21,
    payer_id: 2,
    payer_name: 'EVERGREEN HEALTH PLAN',
    trace_number: 'EFT1001',
    payment_method: 'ACH',
    payment_date: '2026-09-25',
    total_paid_cents: 10000,
    provider_adjustments: [],
    status: 'needs_review',
    source: 'upload',
    file_id: 4,
    posted_at: null,
    created_at: '2026-09-25T18:00:00Z',
    claim_count: 1,
    unmatched_count: 0,
    claims: [paymentFixture()],
    ...changes,
  };
}

export function eligibilityFixture(changes: Partial<EligibilityCheck> = {}): EligibilityCheck {
  return {
    id: 41,
    policy_id: 3,
    status: 'active',
    result: {
      check_id: 'chk_1',
      plan_name: 'Evergreen PPO',
      group_number: 'GRP100',
      coverage_start: '2026-01-01',
      coverage_end: null,
      in_network: true,
      copay_cents: 3000,
      coinsurance_percent: 20,
      deductible_cents: 100000,
      deductible_remaining_cents: 45000,
      out_of_pocket_cents: null,
      out_of_pocket_remaining_cents: null,
      prior_authorization_required: false,
      messages: [],
      errors: [],
    },
    error: '',
    checked_by_id: 1,
    created_at: '2026-09-20T16:00:00Z',
    ...changes,
  };
}

/** A clinician who handles billing for their own clients only. */
export const CLINICIAN_BILLING_OWN = testSession({
  staff: { id: 2, first_name: 'Jordan', last_name: 'Park', role: 'clinician', clinician_access: 'billing' },
  capabilities: ['billing_own'],
});

/** A biller: every client's billing, no practice settings. */
export const BILLER = testSession({
  staff: { id: 3, first_name: 'Sam', last_name: 'Ortiz', role: 'biller', is_clinician: false },
  capabilities: ['view_all_clients', 'billing_all', 'view_reports'],
});

/**
 * Render an insurance screen signed in as `session`, at `path`. With `route` (e.g.
 * "/portal/billing/claims/:claimId") the element is mounted on that route so params work.
 */
export function renderInsurance(
  ui: ReactElement,
  { session = testSession(), path = '/', route }: { session?: Session; path?: string; route?: string } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={session}>
          <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
            {route ? (
              <Routes>
                <Route path={route} element={ui} />
                <Route path="*" element={<p>Navigated away</p>} />
              </Routes>
            ) : (
              ui
            )}
          </MemoryRouter>
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
