import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { estimateOverrideDetail } from '../../api/billing';
import type { Estimate, EstimateDraftInput } from '../../api/estimates';
import {
  addDays,
  buildDraftPayload,
  canChangeEstimate,
  diagnosisChoices,
  diagnosisLetter,
  emptyForm,
  formFromDraft,
  formTotalCents,
  issueProblems,
  maxPeriodEnd,
  newItem,
  totalLabel,
  type EstimateForm,
} from './estimateHelpers';

const ANXIETY = { code: 'F41.1', description: 'Generalized anxiety disorder' };
const DEPRESSION = { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' };

function estimate(changes: Partial<Estimate> = {}): Estimate {
  return {
    id: 4,
    client: { id: 7, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' },
    clinician_id: 1,
    clinician_name: 'Dana Lee, LCSW',
    status: 'draft',
    supersedes_id: null,
    superseded_by_id: null,
    change_summary: '',
    reason: 'scheduling',
    due_on: '2026-10-01',
    overdue: false,
    period_start: '2026-10-01',
    period_end: '2027-09-30',
    primary_service: 'Individual psychotherapy',
    scheduled_dates: [],
    diagnosis_codes: [],
    items: [
      {
        id: 1,
        description: 'Psychotherapy, 53 minutes',
        service_code: '90837',
        location: '',
        diagnosis_pointers: [],
        unit_fee_cents: 15000,
        quantity: 12,
        frequency: 'Weekly',
        total_cents: 180000,
      },
    ],
    separately_scheduled: [],
    notes: '',
    total_cents: 180000,
    provider: {
      name: 'Dana Lee',
      credentials: 'LCSW',
      type: 'LCSW',
      practice_name: 'Lee Counseling',
      address_lines: [],
      contact: '',
      phone: '',
      email: '',
      npi: '',
      npi_kind: 'individual',
      tin: '',
      tin_type: 'EIN',
      states: [],
      locations: [],
    },
    missing_provider_fields: [],
    issued_at: null,
    issued_by_name: '',
    delivery_method: 'portal',
    pdf_sha256: '',
    acknowledged_at: null,
    acknowledged_name: '',
    voided_at: null,
    void_reason: '',
    created_at: '2026-09-26T12:00:00Z',
    updated_at: '2026-09-26T12:00:00Z',
    ...changes,
  };
}

function validForm(changes: Partial<EstimateForm> = {}): EstimateForm {
  return {
    ...emptyForm('2026-10-01', 1),
    primary_service: '  Individual psychotherapy  ',
    diagnoses: ['F41.1', 'F33.1'],
    items: [
      newItem({
        description: 'Psychotherapy, 53 minutes',
        service_code: '90837',
        unit_fee: '150',
        quantity: '12',
        frequency: 'Weekly',
        diagnosis_codes: ['F33.1'],
      }),
    ],
    ...changes,
  };
}

describe('estimate dates', () => {
  it.each([
    ['2026-10-01', '2027-09-30'],
    ['2026-01-01', '2026-12-31'],
    ['2028-02-29', '2029-02-28'],
  ])('lets an estimate starting %s run through %s (12 months)', (start, end) => {
    expect(maxPeriodEnd(start)).toBe(end);
  });

  it('moves plain dates across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('starts a blank estimate today for 12 months', () => {
    const form = emptyForm('2026-10-01', 3);
    expect(form.clinician_id).toBe('3');
    expect(form.period_start).toBe('2026-10-01');
    expect(form.period_end).toBe('2027-09-30');
  });
});

describe('buildDraftPayload', () => {
  it('builds the API body, lettering diagnoses and pointing services at them', () => {
    const result = buildDraftPayload(validForm(), [ANXIETY, DEPRESSION]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      clinician_id: 1,
      period_start: '2026-10-01',
      period_end: '2027-09-30',
      primary_service: 'Individual psychotherapy',
      scheduled_dates: [],
      diagnosis_codes: [ANXIETY, DEPRESSION],
      items: [
        {
          description: 'Psychotherapy, 53 minutes',
          service_code: '90837',
          location: '',
          diagnosis_pointers: ['B'],
          unit_fee_cents: 15000,
          quantity: 12,
          frequency: 'Weekly',
        },
      ],
      separately_scheduled: [],
      notes: '',
      change_summary: '',
      due_on: null,
    });
  });

  it('allows a no-charge service and sorts and de-duplicates scheduled dates', () => {
    const form = validForm({
      scheduled_dates: ['2026-10-15', '2026-10-08', '2026-10-15'],
      items: [newItem({ description: 'Free consultation', unit_fee: '0', quantity: '1' })],
    });
    const result = buildDraftPayload(form, []);
    expect(result.ok && result.payload.scheduled_dates).toEqual(['2026-10-08', '2026-10-15']);
    expect(result.ok && result.payload.items[0].unit_fee_cents).toBe(0);
  });

  it.each<[string, Partial<EstimateForm>, string, string]>([
    ['no clinician', { clinician_id: '' }, 'clinician_id', 'Choose the clinician.'],
    ['no primary service', { primary_service: ' ' }, 'primary_service', 'Describe the main service'],
    ['a reversed period', { period_end: '2026-09-01' }, 'period_end', "can't end before it starts"],
    ['more than 12 months', { period_end: '2027-10-01' }, 'period_end', 'at most 12 months'],
  ])('rejects %s', (_case, changes, field, message) => {
    const result = buildDraftPayload(validForm(changes), [ANXIETY, DEPRESSION]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[field as keyof typeof result.errors]).toContain(message);
  });

  it('reports problems on each service line', () => {
    const bad = newItem({ description: '', unit_fee: 'abc', quantity: '0' });
    const result = buildDraftPayload(validForm({ items: [bad] }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.items[bad.key]).toEqual({
      description: 'Describe the service.',
      unit_fee: 'Enter the fee per session, like 150 or 0 for no charge.',
      quantity: 'Enter a whole number from 1 to 400.',
    });
  });

  it('needs a description for items scheduled separately', () => {
    const result = buildDraftPayload(
      validForm({ separately: [{ key: 's1', description: ' ', provider: 'Dr. Kim', note: '' }] }),
      [],
    );
    expect(!result.ok && result.errors.separately.s1).toBe('Describe the item or service.');
  });
});

describe('formFromDraft', () => {
  it('turns diagnosis letters back into codes and fees into dollars', () => {
    const draft: EstimateDraftInput = {
      clinician_id: 2,
      period_start: '2026-10-01',
      period_end: '2027-09-30',
      primary_service: 'Therapy',
      scheduled_dates: ['2026-10-08'],
      diagnosis_codes: [ANXIETY, DEPRESSION],
      items: [
        {
          description: 'Therapy',
          service_code: '90834',
          location: 'Telehealth',
          diagnosis_pointers: ['A', 'B'],
          unit_fee_cents: 12550,
          quantity: 4,
          frequency: 'Weekly',
        },
      ],
      separately_scheduled: [],
      notes: '',
      change_summary: '',
      due_on: '2026-10-02',
    };
    const form = formFromDraft(draft);
    expect(form.clinician_id).toBe('2');
    expect(form.diagnoses).toEqual(['F41.1', 'F33.1']);
    expect(form.items[0].diagnosis_codes).toEqual(['F41.1', 'F33.1']);
    expect(form.items[0].unit_fee).toBe('125.50');
    expect(form.due_on).toBe('2026-10-02');
    expect(formTotalCents(form)).toBe(50200);
    const again = buildDraftPayload(form, [ANXIETY, DEPRESSION]);
    expect(again.ok && again.payload.items[0].diagnosis_pointers).toEqual(['A', 'B']);
  });
});

describe('issueProblems', () => {
  it('is empty for a complete draft', () => {
    expect(issueProblems(estimate(), [])).toEqual([]);
  });

  it('lists everything missing in plain language', () => {
    const problems = issueProblems(
      estimate({
        items: [],
        missing_provider_fields: [
          "the clinician's NPI to their profile (Settings → Team, or My profile)",
          "the practice's tax ID in Settings → Practice",
        ],
      }),
      ['date of birth'],
    );
    expect(problems).toEqual([
      'Add at least one service with its expected charge.',
      "Add the client's date of birth to their profile.",
      "Add the clinician's NPI to their profile (Settings → Team, or My profile).",
      "Add the practice's tax ID in Settings → Practice.",
    ]);
  });

  it("leaves a replacement's change summary to the issue dialog", () => {
    expect(issueProblems(estimate({ supersedes_id: 3, change_summary: '' }), [])).toEqual([]);
  });
});

describe('estimate display helpers', () => {
  it('letters diagnoses A to L', () => {
    expect(diagnosisLetter(0)).toBe('A');
    expect(diagnosisLetter(11)).toBe('L');
  });

  it('offers the client diagnoses plus any already on the estimate, once each', () => {
    const old = { code: 'F43.23', description: 'Adjustment disorder' };
    expect(diagnosisChoices([ANXIETY], [ANXIETY, old])).toEqual([ANXIETY, old]);
  });

  it('lets billing staff change any estimate and clinicians their own', () => {
    expect(canChangeEstimate({ clinician_id: 2 }, { billing: true, staffId: 1 })).toBe(true);
    expect(canChangeEstimate({ clinician_id: 2 }, { billing: false, staffId: 2 })).toBe(true);
    expect(canChangeEstimate({ clinician_id: 2 }, { billing: false, staffId: 1 })).toBe(false);
  });

  it('says "No charge" for no-cost estimates', () => {
    expect(totalLabel(0)).toBe('No charge');
    expect(totalLabel(180000)).toBe('$1,800.00');
  });
});

describe('estimateOverrideDetail', () => {
  it('recognizes the invoice override conflict', () => {
    const error = new ApiError(409, {
      code: 'estimate_override_required',
      message: 'This invoice bills $450.00 more than the estimate.',
      over_by_cents: 45000,
    });
    expect(estimateOverrideDetail(error)).toEqual({
      code: 'estimate_override_required',
      message: 'This invoice bills $450.00 more than the estimate.',
      over_by_cents: 45000,
    });
  });

  it('ignores other errors', () => {
    expect(estimateOverrideDetail(new ApiError(409, 'That session is already invoiced'))).toBeNull();
    expect(estimateOverrideDetail(new Error('offline'))).toBeNull();
  });
});
