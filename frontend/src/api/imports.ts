import { API_URL } from '../lib/config';
import { ApiError, api, getAccessToken } from './client';

/** What an uploaded import file is (SimplePractice exports and reports). */
export type ImportFileKind =
  | 'export_zip'
  | 'client_details'
  | 'client_demographics'
  | 'appointment_status'
  | 'attendance'
  | 'outstanding_balances'
  | 'client_list';

export type ImportStatus = 'uploaded' | 'analyzing' | 'ready' | 'importing' | 'completed' | 'failed' | 'canceled';

/** One column the importer understands in a file kind. */
export interface ImportFieldInfo {
  name: string;
  label: string;
  required: boolean;
}

/** A kind of file the importer accepts, with where to find it in SimplePractice. */
export interface ImportKindInfo {
  kind: ImportFileKind;
  label: string;
  description: string;
  extensions: string[];
  fields: ImportFieldInfo[];
}

/** An uploaded source file. */
export interface ImportFile {
  file_id: number;
  kind: ImportFileKind | null;
  detected_kind: ImportFileKind | null;
  filename: string;
  size_bytes: number;
  /** Column headings found in the file (spreadsheets only). */
  headers: string[];
  /** Whether a zip's contents are password protected. */
  encrypted: boolean;
}

/** What the analysis found in one spreadsheet. */
export interface PreviewFile {
  file_id: number;
  kind: ImportFileKind;
  filename: string;
  rows: number;
  /** Field name -> the column heading it's read from (null when not found). */
  columns: Record<string, string | null>;
  missing_required: string[];
  /** A few rows of mapped values (identifying details only). */
  sample: Record<string, string>[];
}

export interface PreviewFolder {
  name: string;
  clients: number;
  files: number;
}

export interface PreviewCounts {
  clients_new: number;
  clients_existing: number;
  contacts: number;
  insurance_policies: number;
  clients_with_diagnoses: number;
  appointments: number;
  future_appointments_skipped: number;
  documents: number;
  psychotherapy_notes: number;
  secure_messages: number;
  documents_skipped: number;
  balances: number;
  balance_total_cents: number;
}

/** A client in the import (its key) or an existing Synari client (its id as text). */
export interface MatchCandidate {
  key: string;
  name: string;
  detail: string;
}

/** A name that may be a client already in the import; the practice confirms or rejects it. */
export interface MatchReview {
  id: string;
  name: string;
  sources: string[];
  reason: 'similar_name' | 'same_name';
  candidates: MatchCandidate[];
  /** The chosen candidate key, '' to keep it separate, null while undecided (kept separate). */
  decision: string | null;
}

/** A client in the import that may already exist in Synari. */
export interface ExistingReview {
  key: string;
  name: string;
  detail: string;
  candidates: MatchCandidate[];
  /** The existing client's id to update, 0 to add a new client, null while undecided (new). */
  decision: number | null;
}

export interface ClinicianInvite {
  first_name: string;
  last_name: string;
  email: string;
}

/** A clinician named in the SimplePractice files and who they become in Synari. */
export interface PreviewClinician {
  key: string;
  name: string;
  clients: number;
  appointments: number;
  /** The Synari clinician chosen (or suggested); null uses the default clinician. */
  staff_id: number | null;
  /** Found automatically by name (or because the practice has one clinician). */
  matched: boolean;
  invite: ClinicianInvite | null;
}

export interface ImportWarning {
  code: string;
  message: string;
  count: number;
}

export interface ImportPreview {
  analyzed_at: string;
  counts: PreviewCounts;
  files: PreviewFile[];
  folders: PreviewFolder[];
  matches: MatchReview[];
  existing: ExistingReview[];
  clinicians: PreviewClinician[];
  warnings: ImportWarning[];
}

/** Progress while importing, then the summary. Counts are per kind of record. */
export interface ImportResult {
  phase: string;
  processed: number;
  total: number;
  created: Record<string, number>;
  updated: Record<string, number>;
  skipped: Record<string, number>;
  warnings: ImportWarning[];
}

/**
 * Who a SimplePractice clinician becomes: an existing clinician, a new invited one, or (neither
 * set) the default clinician.
 */
export interface ClinicianChoice {
  staff_id?: number | null;
  invite?: ClinicianInvite | null;
}

/** Choices made while reviewing the preview. */
export interface ImportOptions {
  default_clinician_id: number | null;
  clinicians: Record<string, ClinicianChoice>;
  /** Match review id -> candidate key, or '' to keep separate. */
  matches: Record<string, string>;
  /** Import client key -> existing client id to update, or 0 to add a new client. */
  existing: Record<string, number>;
  create_missing_clients: boolean;
  import_contacts: boolean;
  import_insurance: boolean;
  import_appointments: boolean;
  import_documents: boolean;
  import_balances: boolean;
}

export interface ImportOptionsOut extends ImportOptions {
  zip_password_set: boolean;
}

export interface ImportJobSummary {
  id: number;
  source: string;
  status: ImportStatus;
  created_by_id: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  file_count: number;
}

/** File id (as text) -> field name -> column heading (null = not imported). */
export type ImportMapping = Record<string, Record<string, string | null>>;

export interface ImportJob extends ImportJobSummary {
  files: ImportFile[];
  mapping: ImportMapping;
  options: ImportOptionsOut;
  preview: ImportPreview | null;
  result: ImportResult | null;
  error: string;
}

/**
 * Correct file kinds or column mapping (both need a new analysis), set the zip password ('' clears
 * it) or replace the options.
 */
export interface ImportJobUpdate {
  files?: { file_id: number; kind: ImportFileKind }[];
  mapping?: ImportMapping;
  options?: ImportOptions;
  zip_password?: string;
}

/** Extensions the importer accepts. */
export const IMPORT_EXTENSIONS = ['.zip', '.csv', '.xlsx'] as const;

/** Largest import file when the server doesn't say (it's configurable with IMPORT_MAX_BYTES). */
export const DEFAULT_IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function errorDetail(responseText: string): unknown {
  try {
    const data = JSON.parse(responseText) as { detail?: unknown };
    return data.detail ?? data;
  } catch {
    return null;
  }
}

export interface ImportUploadOptions {
  /** The file's kind when known; otherwise the server detects it from the columns. */
  kind?: ImportFileKind | null;
  /** Called with the uploaded fraction (0 to 1) as the file is sent. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Upload one source file to an import with progress. Exports can be hundreds of megabytes, and
 * fetch() can't report upload progress, so this uses XMLHttpRequest with the staff bearer token.
 */
export async function uploadImportFile(
  jobId: number,
  file: File,
  { kind, onProgress, signal }: ImportUploadOptions = {},
): Promise<ImportJob> {
  if (signal?.aborted) throw new DOMException('Upload canceled', 'AbortError');
  const token = await getAccessToken('staff');
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_URL}/imports/${jobId}/files`);
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(1);
        resolve(JSON.parse(request.responseText) as ImportJob);
      } else {
        reject(new ApiError(request.status, errorDetail(request.responseText)));
      }
    };
    request.onerror = () => reject(new ApiError(0, null));
    request.onabort = () => reject(new DOMException('Upload canceled', 'AbortError'));
    signal?.addEventListener('abort', () => request.abort(), { once: true });
    const form = new FormData();
    form.append('file', file);
    if (kind) form.append('kind', kind);
    request.send(form);
  });
}

/** Importing a practice from SimplePractice (needs the manage_practice capability). */
export const importsApi = {
  kinds: () => api<ImportKindInfo[]>('/imports/kinds'),
  list: () => api<ImportJobSummary[]>('/imports'),
  get: (jobId: number) => api<ImportJob>(`/imports/${jobId}`),
  create: () => api<ImportJob>('/imports', { method: 'POST', body: {} }),
  upload: uploadImportFile,
  removeFile: (jobId: number, fileId: number) =>
    api<ImportJob>(`/imports/${jobId}/files/${fileId}`, { method: 'DELETE' }),
  update: (jobId: number, changes: ImportJobUpdate) =>
    api<ImportJob>(`/imports/${jobId}`, { method: 'PATCH', body: changes }),
  analyze: (jobId: number) => api<ImportJob>(`/imports/${jobId}/analyze`, { method: 'POST' }),
  start: (jobId: number) => api<ImportJob>(`/imports/${jobId}/start`, { method: 'POST' }),
  cancel: (jobId: number) => api<ImportJob>(`/imports/${jobId}/cancel`, { method: 'POST' }),
};

export const importKeys = {
  all: ['imports'] as const,
  kinds: ['imports', 'kinds'] as const,
  list: ['imports', 'list'] as const,
  detail: (jobId: number) => ['imports', 'detail', jobId] as const,
};
