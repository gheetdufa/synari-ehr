import type { ClaimDetail, ClaimLineUpdate, ClaimUpdate } from '../../../api/claims';

/** One service line being edited. Pointers are diagnosis codes, so reordering keeps them right. */
export interface LineDraft {
  id: number;
  procedure_code: string;
  /** Typed as text: "95, HO". */
  modifiers: string;
  units: string;
  place_of_service: string;
  pointers: string[];
}

/** The editable parts of a draft or rejected claim. */
export interface ClaimDraft {
  /** ICD-10 codes without the dot, first = primary. */
  diagnosis_codes: string[];
  place_of_service: string;
  prior_authorization_number: string;
  payer_claim_number: string;
  rendering_clinician_id: number;
  supervising_clinician_id: number | null;
  lines: LineDraft[];
}

export const MAX_DIAGNOSES = 12;
export const MAX_POINTERS = 4;
export const MAX_MODIFIERS = 4;

const ICD10 = /^[A-Z][0-9][0-9A-Z][0-9A-Z]{0,4}$/;
const PROCEDURE = /^[A-Z0-9]{5}$/;
const MODIFIER = /^[A-Z0-9]{2}$/;
const PLACE_OF_SERVICE = /^\d{2}$/;

/** "f41.1 " -> "F411" (claims store ICD-10 codes without the dot). */
export function normalizeDiagnosis(input: string): string {
  return input.trim().toUpperCase().replace(/\./g, '');
}

export function isDiagnosisCode(code: string): boolean {
  return ICD10.test(code);
}

/** "95, ho" -> ["95", "HO"]. */
export function parseModifiers(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean);
}

export function claimDraftFrom(claim: ClaimDetail): ClaimDraft {
  return {
    diagnosis_codes: [...claim.diagnosis_codes],
    place_of_service: claim.place_of_service,
    prior_authorization_number: claim.prior_authorization_number,
    payer_claim_number: claim.payer_claim_number,
    rendering_clinician_id: claim.rendering_clinician_id,
    supervising_clinician_id: claim.supervising_clinician_id,
    lines: claim.lines.map((line) => ({
      id: line.id,
      procedure_code: line.procedure_code,
      modifiers: line.modifiers.join(', '),
      units: String(line.units),
      place_of_service: line.place_of_service,
      pointers: line.diagnosis_pointers
        .map((pointer) => claim.diagnosis_codes[pointer - 1])
        .filter((code): code is string => Boolean(code)),
    })),
  };
}

/** Add a diagnosis at the end; lines that point to nothing yet point to it. */
export function addDiagnosis(draft: ClaimDraft, code: string): ClaimDraft {
  return {
    ...draft,
    diagnosis_codes: [...draft.diagnosis_codes, code],
    lines: draft.lines.map((line) => (line.pointers.length === 0 ? { ...line, pointers: [code] } : line)),
  };
}

/** Remove a diagnosis and every line's pointer to it. */
export function removeDiagnosis(draft: ClaimDraft, code: string): ClaimDraft {
  return {
    ...draft,
    diagnosis_codes: draft.diagnosis_codes.filter((existing) => existing !== code),
    lines: draft.lines.map((line) => ({ ...line, pointers: line.pointers.filter((pointer) => pointer !== code) })),
  };
}

/** Move the diagnosis at `index` up (-1) or down (+1). */
export function moveDiagnosis(draft: ClaimDraft, index: number, direction: -1 | 1): ClaimDraft {
  const target = index + direction;
  if (target < 0 || target >= draft.diagnosis_codes.length) return draft;
  const codes = [...draft.diagnosis_codes];
  [codes[index], codes[target]] = [codes[target], codes[index]];
  return { ...draft, diagnosis_codes: codes };
}

/** Point a line at a diagnosis (added last) or stop pointing at it. */
export function togglePointer(line: LineDraft, code: string): LineDraft {
  return line.pointers.includes(code)
    ? { ...line, pointers: line.pointers.filter((pointer) => pointer !== code) }
    : { ...line, pointers: [...line.pointers, code] };
}

/** Why a new diagnosis can't be added, or null. */
export function diagnosisError(draft: ClaimDraft, code: string): string | null {
  if (!isDiagnosisCode(code)) return 'Enter an ICD-10 code, like F41.1';
  if (draft.diagnosis_codes.includes(code)) return 'That diagnosis is already on the claim';
  if (draft.diagnosis_codes.length >= MAX_DIAGNOSES) return `A claim can list up to ${MAX_DIAGNOSES} diagnoses`;
  return null;
}

export function lineErrorKey(lineId: number, field: string): string {
  return `line-${lineId}-${field}`;
}

/** Problems that would make the API refuse the edit, keyed by field (lines by `lineErrorKey`). */
export function validateClaimDraft(draft: ClaimDraft, claim: ClaimDetail): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!PLACE_OF_SERVICE.test(draft.place_of_service)) errors.place_of_service = 'Use a two-digit code, like 11 or 10';
  if (draft.prior_authorization_number.trim().length > 50) errors.prior_authorization_number = 'Use 50 characters or fewer';
  if (draft.payer_claim_number.trim().length > 50) errors.payer_claim_number = 'Use 50 characters or fewer';
  const originalLines = new Map(claim.lines.map((line) => [line.id, line]));
  for (const line of draft.lines) {
    const key = (field: string) => lineErrorKey(line.id, field);
    if (!PROCEDURE.test(line.procedure_code.trim().toUpperCase())) {
      errors[key('procedure_code')] = 'Use a 5-character code, like 90837';
    }
    const modifiers = parseModifiers(line.modifiers);
    if (modifiers.length > MAX_MODIFIERS) errors[key('modifiers')] = `Up to ${MAX_MODIFIERS} modifiers`;
    else if (!modifiers.every((modifier) => MODIFIER.test(modifier))) {
      errors[key('modifiers')] = 'Modifiers are 2 letters or digits, like 95';
    }
    const units = Number(line.units);
    if (!Number.isInteger(units) || units < 1 || units > 99) errors[key('units')] = 'Between 1 and 99';
    const originalPlace = originalLines.get(line.id)?.place_of_service ?? '';
    if (line.place_of_service !== originalPlace && !PLACE_OF_SERVICE.test(line.place_of_service)) {
      errors[key('place_of_service')] = 'Two digits';
    }
    if (draft.diagnosis_codes.length > 0 && (line.pointers.length === 0 || line.pointers.length > MAX_POINTERS)) {
      errors[key('pointers')] = `Choose 1 to ${MAX_POINTERS} diagnoses`;
    }
  }
  return errors;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The PATCH body for what changed between `claim` and `draft` (empty when nothing did). */
export function claimUpdate(claim: ClaimDetail, draft: ClaimDraft): ClaimUpdate {
  const update: ClaimUpdate = {};
  if (!same(draft.diagnosis_codes, claim.diagnosis_codes)) update.diagnosis_codes = draft.diagnosis_codes;
  if (draft.place_of_service !== claim.place_of_service) update.place_of_service = draft.place_of_service;
  const authorization = draft.prior_authorization_number.trim();
  if (authorization !== claim.prior_authorization_number) update.prior_authorization_number = authorization;
  const payerClaimNumber = draft.payer_claim_number.trim();
  if (payerClaimNumber !== claim.payer_claim_number) update.payer_claim_number = payerClaimNumber;
  if (draft.rendering_clinician_id !== claim.rendering_clinician_id) update.rendering_clinician_id = draft.rendering_clinician_id;
  if (draft.supervising_clinician_id !== claim.supervising_clinician_id) {
    update.supervising_clinician_id = draft.supervising_clinician_id;
  }

  const lines: ClaimLineUpdate[] = [];
  for (const line of draft.lines) {
    const original = claim.lines.find((candidate) => candidate.id === line.id);
    if (!original) continue;
    const change: ClaimLineUpdate = { id: line.id };
    const procedure = line.procedure_code.trim().toUpperCase();
    if (procedure !== original.procedure_code) change.procedure_code = procedure;
    const modifiers = parseModifiers(line.modifiers);
    if (!same(modifiers, original.modifiers)) change.modifiers = modifiers;
    const units = Number(line.units);
    if (units !== original.units) change.units = units;
    if (line.place_of_service !== original.place_of_service) change.place_of_service = line.place_of_service;
    const pointers = line.pointers
      .map((code) => draft.diagnosis_codes.indexOf(code) + 1)
      .filter((pointer) => pointer > 0);
    if (pointers.length > 0 && !same(pointers, original.diagnosis_pointers)) change.diagnosis_pointers = pointers;
    if (Object.keys(change).length > 1) lines.push(change);
  }
  if (lines.length > 0) update.lines = lines;
  return update;
}
