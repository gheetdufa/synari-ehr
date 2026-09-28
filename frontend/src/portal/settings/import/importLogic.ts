import {
  IMPORT_EXTENSIONS,
  type ClinicianChoice,
  type ImportFieldInfo,
  type ImportFile,
  type ImportFileKind,
  type ImportJob,
  type ImportKindInfo,
  type ImportMapping,
  type ImportOptions,
  type ImportPreview,
  type ImportStatus,
} from '../../../api/imports';
import { formatBytes } from '../../../lib/format';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export const STATUS_LABELS: Record<ImportStatus, { label: string; tone: Tone }> = {
  uploaded: { label: 'Waiting for files', tone: 'neutral' },
  analyzing: { label: 'Analyzing', tone: 'info' },
  ready: { label: 'Ready to review', tone: 'primary' },
  importing: { label: 'Importing', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

/** Statuses the worker is busy with; the page polls while a job is in one of them. */
export const BUSY_STATUSES: readonly ImportStatus[] = ['analyzing', 'importing'];
/** Statuses that end an import. */
export const FINAL_STATUSES: readonly ImportStatus[] = ['completed', 'canceled'];

/** Names for file kinds when the server's catalog hasn't loaded. */
export const KIND_LABELS: Record<ImportFileKind, string> = {
  export_zip: 'Complete export (zip)',
  client_details: 'Client details report',
  client_demographics: 'Client demographics report',
  appointment_status: 'Appointment status report',
  attendance: 'Attendance report',
  outstanding_balances: 'Outstanding balances report',
  client_list: 'Client List (from SimplePractice support)',
};

export function kindLabel(kind: ImportFileKind | null, kinds: ImportKindInfo[] | undefined): string {
  if (!kind) return 'Not recognized';
  return kinds?.find((info) => info.kind === kind)?.label ?? KIND_LABELS[kind];
}

/** Labels for the import's phases, shown with the progress bar. */
const PHASE_LABELS: Record<string, string> = {
  clinicians: 'Setting up clinicians',
  clients: 'Importing clients',
  contacts: 'Importing contacts',
  insurance: 'Importing insurance',
  policies: 'Importing insurance',
  diagnoses: 'Importing diagnoses',
  appointments: 'Importing past appointments',
  documents: 'Importing documents',
  balances: 'Carrying over balances',
  cleanup: 'Finishing up',
  done: 'Finishing up',
};

export function phaseLabel(phase: string): string {
  if (!phase) return 'Starting';
  return PHASE_LABELS[phase] ?? phase.charAt(0).toUpperCase() + phase.slice(1).replace(/_/g, ' ');
}

/** Whole-number percentage of `processed` out of `total` (0 when the total isn't known yet). */
export function progressPercent(processed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
}

/** Plural-aware "3 clients" / "1 client". */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}

/** Why a file can't be uploaded to an import, checked before sending it; null when it looks fine. */
export function importFileProblem(file: File, maxBytes: number): string | null {
  const dot = file.name.lastIndexOf('.');
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (extension === '.xls') return `${file.name}: save it as .xlsx or .csv first (older .xls files can't be read).`;
  if (!(IMPORT_EXTENSIONS as readonly string[]).includes(extension)) {
    return `${file.name}: use the SimplePractice export zip or reports as .csv or .xlsx.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > maxBytes) return `${file.name} is larger than ${formatBytes(maxBytes)}.`;
  return null;
}

/** Whether a file is a spreadsheet report (it has columns to map). */
export function isSpreadsheet(file: ImportFile): boolean {
  return file.kind !== null && file.kind !== 'export_zip';
}

/** Required name fields that First name and Last name columns can stand in for together. */
const SPLIT_NAME_FIELDS: readonly string[] = ['name', 'client'];

/** Whether a required name field of this report may instead come from its First name and Last name columns. */
export function acceptsSplitName(info: ImportKindInfo, fieldName: string): boolean {
  const has = (name: string) => info.fields.some((field) => field.name === name);
  return SPLIT_NAME_FIELDS.includes(fieldName) && has('first_name') && has('last_name');
}

/** A report's required fields without a column; a name may come from first + last name (as on the server). */
export function unmatchedRequired(info: ImportKindInfo, columns: Record<string, string | null>): ImportFieldInfo[] {
  const splitName = Boolean(columns.first_name && columns.last_name);
  return info.fields.filter(
    (field) => field.required && !columns[field.name] && !(splitName && SPLIT_NAME_FIELDS.includes(field.name)),
  );
}

/** The required fields of a spreadsheet that aren't mapped to a column. */
export function missingRequired(file: ImportFile, mapping: ImportMapping, kinds: ImportKindInfo[] | undefined): string[] {
  if (!isSpreadsheet(file)) return [];
  const info = kinds?.find((candidate) => candidate.kind === file.kind);
  if (!info) return [];
  return unmatchedRequired(info, mapping[String(file.file_id)] ?? {}).map((field) => field.label);
}

/** What still stops the files from being analyzed, in plain language (empty when they can be). */
export function analyzeBlockers(job: ImportJob, kinds: ImportKindInfo[] | undefined): string[] {
  if (job.files.length === 0) return ['Upload at least one SimplePractice file.'];
  const blockers: string[] = [];
  for (const file of job.files) {
    if (!file.kind) blockers.push(`Choose what ${file.filename} is.`);
    if (file.kind === 'export_zip' && file.encrypted && !job.options.zip_password_set) {
      blockers.push(`Enter the password for ${file.filename}.`);
    }
    const missing = missingRequired(file, job.mapping, kinds);
    if (missing.length > 0) blockers.push(`Match ${missing.join(', ')} to a column in ${file.filename}.`);
  }
  return blockers;
}

/** The mapping with one file's field changed, keeping every other file's mapping. */
export function withMappedColumn(
  mapping: ImportMapping,
  fileId: number,
  field: string,
  header: string | null,
): ImportMapping {
  const key = String(fileId);
  return { ...mapping, [key]: { ...(mapping[key] ?? {}), [field]: header } };
}

/** Starting options for the review: saved choices plus the analysis's suggestions. */
export function initialOptions(job: ImportJob): ImportOptions {
  const saved = job.options;
  const preview = job.preview;
  const matches = { ...saved.matches };
  const existing = { ...saved.existing };
  const clinicians: Record<string, ClinicianChoice> = { ...saved.clinicians };
  for (const review of preview?.matches ?? []) {
    if (!(review.id in matches) && review.decision !== null) matches[review.id] = review.decision;
  }
  for (const review of preview?.existing ?? []) {
    if (!(review.key in existing) && review.decision !== null) existing[review.key] = review.decision;
  }
  for (const clinician of preview?.clinicians ?? []) {
    if (clinician.key in clinicians) continue;
    if (clinician.invite) clinicians[clinician.key] = { invite: clinician.invite };
    else if (clinician.staff_id !== null) clinicians[clinician.key] = { staff_id: clinician.staff_id };
  }
  return {
    default_clinician_id: saved.default_clinician_id,
    clinicians,
    matches,
    existing,
    create_missing_clients: saved.create_missing_clients,
    import_contacts: saved.import_contacts,
    import_insurance: saved.import_insurance,
    import_appointments: saved.import_appointments,
    import_documents: saved.import_documents,
    import_balances: saved.import_balances,
  };
}

/** SimplePractice clinicians that end up with the default clinician under these options. */
export function cliniciansUsingDefault(preview: ImportPreview, options: ImportOptions): string[] {
  return preview.clinicians
    .filter((clinician) => {
      const choice = options.clinicians[clinician.key];
      return !choice || (choice.staff_id == null && !choice.invite);
    })
    .map((clinician) => clinician.name);
}

/** What still stops the import from starting under these options (empty when it can start). */
export function startBlockers(preview: ImportPreview, options: ImportOptions): string[] {
  const blockers: string[] = [];
  const defaulted = cliniciansUsingDefault(preview, options);
  if (defaulted.length > 0 && options.default_clinician_id === null) {
    blockers.push(`Choose a Synari clinician for ${defaulted.join(', ')}, or a default clinician.`);
  }
  for (const clinician of preview.clinicians) {
    const invite = options.clinicians[clinician.key]?.invite;
    if (invite && (!invite.first_name.trim() || !invite.last_name.trim() || !invite.email.trim())) {
      blockers.push(`Enter a name and email to invite a clinician for ${clinician.name}.`);
    }
  }
  return blockers;
}

/** Kinds of records the import reports on, in display order, with their labels. */
export const RECORD_KINDS: { key: string; label: string }[] = [
  { key: 'client', label: 'Clients' },
  { key: 'contact', label: 'Contacts' },
  { key: 'policy', label: 'Insurance policies' },
  { key: 'payer', label: 'Insurance payers' },
  { key: 'clinician', label: 'Invited clinicians' },
  { key: 'appointment', label: 'Past appointments' },
  { key: 'document', label: 'Documents' },
  { key: 'balance', label: 'Opening balances' },
];

/** Rows for the results table: known kinds first, then any others the server reports. */
export function resultRows(
  result: Pick<NonNullable<ImportJob['result']>, 'created' | 'updated' | 'skipped'>,
): { key: string; label: string; created: number; updated: number; skipped: number }[] {
  const keys = new Set([...Object.keys(result.created), ...Object.keys(result.updated), ...Object.keys(result.skipped)]);
  const known = RECORD_KINDS.filter((kind) => keys.has(kind.key));
  const others = [...keys]
    .filter((key) => !RECORD_KINDS.some((kind) => kind.key === key))
    .sort()
    .map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ') }));
  return [...known, ...others].map(({ key, label }) => ({
    key,
    label,
    created: result.created[key] ?? 0,
    updated: result.updated[key] ?? 0,
    skipped: result.skipped[key] ?? 0,
  }));
}
