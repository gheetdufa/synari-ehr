import { api, downloadFile } from './client';

export type FormKind = 'intake' | 'consent' | 'assessment' | 'other';
export type ClientFormStatus = 'pending' | 'completed';
export type FieldType =
  | 'heading'
  | 'paragraph'
  | 'short_text'
  | 'long_text'
  | 'date'
  | 'single_choice'
  | 'multi_choice'
  | 'yes_no';

/** Client record columns a form answer may fill in while they are still empty. */
export type MappableField =
  | 'preferred_name'
  | 'pronouns'
  | 'date_of_birth'
  | 'gender_identity'
  | 'phone'
  | 'address_line1'
  | 'address_line2'
  | 'city'
  | 'state'
  | 'postal_code'
  | 'emergency_contact_name'
  | 'emergency_contact_phone'
  | 'emergency_contact_relationship';

/** Option values are whole numbers (scored items) or text; never mixed within one question. */
export type OptionValue = number | string;

export interface ChoiceOption {
  label: string;
  value: OptionValue;
}

/** One item on a form. Headings and paragraphs are display text (a paragraph's text is its label). */
export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  required?: boolean;
  options?: ChoiceOption[] | null;
  help?: string;
  maps_to?: MappableField | null;
}

/** An answer as the API stores it: text/date strings, yes/no booleans, option values. */
export type AnswerValue = string | number | boolean | Array<string | number>;
export type Answers = Record<string, AnswerValue>;

export interface ScoreBand {
  min: number;
  max: number;
  label: string;
}

/** Fires when a numeric answer is at least `min`, or an answer equals `equals`. */
export interface ScoreFlag {
  item: string;
  min?: number | null;
  equals?: boolean | number | string | null;
  reason: string;
}

export interface ScoringSpec {
  method: 'sum' | null;
  items: string[];
  max_score: number | null;
  bands: ScoreBand[];
  flags: ScoreFlag[];
}

export interface LibraryForm {
  key: string;
  name: string;
  kind: FormKind;
  description: string;
}

export interface TemplateSummary {
  id: number;
  kind: FormKind;
  name: string;
  description: string;
  requires_signature: boolean;
  library_key: string | null;
  read_only: boolean;
  created_at: string;
  updated_at: string;
}

export interface FormTemplate extends TemplateSummary {
  fields: FormField[];
  scoring: ScoringSpec | null;
}

export interface TemplateInput {
  kind: FormKind;
  name: string;
  description: string;
  fields: FormField[];
  requires_signature: boolean;
}

/**
 * A shared form's status and, for staff with clinical access to the client, its results.
 * `score`, `score_label` and `flagged` are null for staff who may see the client's profile but
 * not their clinical record.
 */
export interface ClientFormSummary {
  id: number;
  client_id: number;
  template_id: number | null;
  kind: FormKind;
  name: string;
  status: ClientFormStatus;
  requires_signature: boolean;
  sent_at: string;
  viewed_at: string | null;
  completed_at: string | null;
  last_reminded_at: string | null;
  reminder_count: number;
  score: number | null;
  score_label: string | null;
  flagged: boolean | null;
}

/** A shared form with the client's answers, score and signature record (staff with clinical access). */
export interface ClientFormDetail extends ClientFormSummary {
  score_label: string;
  flagged: boolean;
  description: string;
  fields: FormField[];
  scoring: ScoringSpec | null;
  answers: Answers | null;
  flag_reason: string;
  signature_name: string;
  signed_at: string | null;
  signer_ip: string;
  signer_user_agent: string;
  /** SHA-256 of the signed form (fields, answers, signer, time); empty when unsigned. */
  signature_sha256: string;
  /** Null when unsigned; "mismatch" means the form changed after it was signed. */
  signature_integrity: 'verified' | 'mismatch' | null;
}

export interface PortalFormSummary {
  id: number;
  kind: FormKind;
  name: string;
  status: ClientFormStatus;
  requires_signature: boolean;
  sent_at: string;
  completed_at: string | null;
}

/** A form as the client sees it: questions, and their own answers once submitted. */
export interface PortalForm extends PortalFormSummary {
  fields: FormField[];
  answers: Answers | null;
  signature_name: string;
  signed_at: string | null;
}

export interface FormSubmission {
  answers: Answers;
  signature_name?: string;
  signature_agreed: boolean;
}

/** 422 detail when a submission has invalid answers or a missing signature. */
export interface SubmissionProblem {
  message: string;
  errors: Record<string, string>;
  signature: string | null;
}

/** Type guard for the 422 detail returned by POST /portal/forms/{id}/submit. */
export function isSubmissionProblem(detail: unknown): detail is SubmissionProblem {
  if (!detail || typeof detail !== 'object') return false;
  const candidate = detail as Partial<SubmissionProblem>;
  return typeof candidate.message === 'string' && !!candidate.errors && typeof candidate.errors === 'object';
}

export const FORM_KINDS: FormKind[] = ['intake', 'consent', 'assessment', 'other'];

export const FORM_KIND_LABELS: Record<FormKind, string> = {
  intake: 'Intake',
  consent: 'Consent',
  assessment: 'Assessment',
  other: 'Other',
};

/** Most forms that can be shared in one request. */
export const MAX_FORMS_PER_SHARE = 20;

/** Staff endpoints: templates, the built-in library and forms shared with clients. */
export const formsApi = {
  library: () => api<LibraryForm[]>('/forms/library'),
  addFromLibrary: (key: string) =>
    api<FormTemplate>(`/forms/library/${encodeURIComponent(key)}`, { method: 'POST' }),
  templates: () => api<TemplateSummary[]>('/forms/templates'),
  template: (id: number) => api<FormTemplate>(`/forms/templates/${id}`),
  createTemplate: (input: TemplateInput) => api<FormTemplate>('/forms/templates', { body: input }),
  updateTemplate: (id: number, changes: Partial<TemplateInput>) =>
    api<FormTemplate>(`/forms/templates/${id}`, { method: 'PATCH', body: changes }),
  archiveTemplate: (id: number) => api<void>(`/forms/templates/${id}`, { method: 'DELETE' }),

  clientForms: (clientId: number) => api<ClientFormSummary[]>(`/clients/${clientId}/forms`),
  share: (clientId: number, templateIds: number[]) =>
    api<ClientFormSummary[]>(`/clients/${clientId}/forms`, { body: { template_ids: templateIds } }),
  clientForm: (formId: number) => api<ClientFormDetail>(`/client-forms/${formId}`),
  withdraw: (formId: number) => api<void>(`/client-forms/${formId}`, { method: 'DELETE' }),
  remind: (formId: number) =>
    api<{ detail: string }>(`/client-forms/${formId}/remind`, { method: 'POST' }),
  downloadPdf: (formId: number) => downloadFile(`/client-forms/${formId}/pdf`),
};

export const formKeys = {
  all: ['forms'] as const,
  templates: ['forms', 'templates'] as const,
  template: (id: number) => ['forms', 'templates', id] as const,
  library: ['forms', 'library'] as const,
  clientForms: (clientId: number) => ['forms', 'client', clientId] as const,
  clientForm: (formId: number) => ['forms', 'client-form', formId] as const,
};

/** Client-portal endpoints for the signed-in client's own forms. */
export const portalFormsApi = {
  list: () => api<PortalFormSummary[]>('/portal/forms', { realm: 'client' }),
  get: (formId: number) => api<PortalForm>(`/portal/forms/${formId}`, { realm: 'client' }),
  submit: (formId: number, submission: FormSubmission) =>
    api<PortalForm>(`/portal/forms/${formId}/submit`, { realm: 'client', body: submission }),
};

export const portalFormKeys = {
  all: ['portal', 'forms'] as const,
  list: ['portal', 'forms', 'list'] as const,
  detail: (formId: number) => ['portal', 'forms', 'detail', formId] as const,
};
