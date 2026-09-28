import { describe, expect, it } from 'vitest';
import { claimFixture } from '../insurance.fixture';
import {
  addDiagnosis,
  claimDraftFrom,
  claimUpdate,
  diagnosisError,
  lineErrorKey,
  moveDiagnosis,
  normalizeDiagnosis,
  parseModifiers,
  removeDiagnosis,
  togglePointer,
  validateClaimDraft,
} from './claimDraft';

describe('claim draft', () => {
  const claim = claimFixture();

  it('keeps pointers as diagnosis codes and sends nothing when unchanged', () => {
    const draft = claimDraftFrom(claim);
    expect(draft.lines.map((line) => line.pointers)).toEqual([['F411', 'F331'], ['F411']]);
    expect(draft.lines[1].modifiers).toBe('95');
    expect(claimUpdate(claim, draft)).toEqual({});
  });

  it('follows pointers when diagnoses are reordered', () => {
    const draft = moveDiagnosis(claimDraftFrom(claim), 1, -1);
    expect(draft.diagnosis_codes).toEqual(['F331', 'F411']);
    expect(claimUpdate(claim, draft)).toEqual({
      diagnosis_codes: ['F331', 'F411'],
      lines: [
        { id: 101, diagnosis_pointers: [2, 1] },
        { id: 102, diagnosis_pointers: [2] },
      ],
    });
  });

  it('drops pointers to a removed diagnosis and points empty lines at a new one', () => {
    const removed = removeDiagnosis(claimDraftFrom(claim), 'F411');
    expect(removed.lines.map((line) => line.pointers)).toEqual([['F331'], []]);
    expect(validateClaimDraft(removed, claim)).toEqual({ [lineErrorKey(102, 'pointers')]: 'Choose 1 to 4 diagnoses' });

    const added = addDiagnosis(removed, 'F4310');
    expect(added.lines.map((line) => line.pointers)).toEqual([['F331'], ['F4310']]);
    expect(claimUpdate(claim, added)).toEqual({
      diagnosis_codes: ['F331', 'F4310'],
      lines: [
        { id: 101, diagnosis_pointers: [1] },
        { id: 102, diagnosis_pointers: [2] },
      ],
    });
  });

  it('sends only the line fields that changed, normalized', () => {
    const draft = claimDraftFrom(claim);
    draft.lines[0] = { ...draft.lines[0], modifiers: '95, ho', units: '2', procedure_code: '90834' };
    draft.prior_authorization_number = ' AUTH-1 ';
    expect(claimUpdate(claim, draft)).toEqual({
      prior_authorization_number: 'AUTH-1',
      lines: [{ id: 101, procedure_code: '90834', modifiers: ['95', 'HO'], units: 2 }],
    });
  });

  it('toggles pointers in the order they are chosen', () => {
    const line = claimDraftFrom(claim).lines[1];
    expect(togglePointer(line, 'F331').pointers).toEqual(['F411', 'F331']);
    expect(togglePointer(line, 'F411').pointers).toEqual([]);
  });

  it('finds values the API would refuse', () => {
    const draft = claimDraftFrom(claim);
    draft.place_of_service = '1';
    draft.lines[0] = { ...draft.lines[0], procedure_code: '9083', modifiers: '95 HO GT AJ U1', units: '0', place_of_service: 'x' };
    expect(validateClaimDraft(draft, claim)).toEqual({
      place_of_service: 'Use a two-digit code, like 11 or 10',
      [lineErrorKey(101, 'procedure_code')]: 'Use a 5-character code, like 90837',
      [lineErrorKey(101, 'modifiers')]: 'Up to 4 modifiers',
      [lineErrorKey(101, 'units')]: 'Between 1 and 99',
      [lineErrorKey(101, 'place_of_service')]: 'Two digits',
    });
  });

  it('checks new diagnosis codes', () => {
    const draft = claimDraftFrom(claim);
    expect(normalizeDiagnosis(' f43.10 ')).toBe('F4310');
    expect(diagnosisError(draft, 'F4310')).toBeNull();
    expect(diagnosisError(draft, 'F411')).toBe('That diagnosis is already on the claim');
    expect(diagnosisError(draft, '43.1')).toBe('Enter an ICD-10 code, like F41.1');
    expect(parseModifiers(' 95,ho  gt')).toEqual(['95', 'HO', 'GT']);
  });
});
