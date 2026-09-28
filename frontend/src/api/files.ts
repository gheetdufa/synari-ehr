import { ApiError, api, downloadFile, uploadFile } from './client';

export type FilePurpose =
  | 'message_attachment'
  | 'client_upload'
  | 'shared_document'
  | 'recording'
  | 'good_faith_estimate'
  | 'imported_document';

/** The imported folder whose files only the client's primary clinician (their author) can open. */
export const PSYCHOTHERAPY_NOTES_CATEGORY = 'Psychotherapy Notes';

export interface StoredFile {
  id: number;
  client_id: number | null;
  purpose: FilePurpose;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: 'staff' | 'client';
  /** The team member who uploaded it (null for client uploads). */
  uploaded_by_staff_id: number | null;
  shared_with_client: boolean;
  /** Where an imported document came from (e.g. "Medical Records"); empty otherwise. */
  category: string;
  created_at: string;
}

/** Extensions the API accepts for documents (mirrors the server's allowlist). */
export const DOCUMENT_EXTENSIONS = [
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.heic',
  '.txt',
  '.csv',
  '.doc',
  '.docx',
  '.mp3',
  '.m4a',
  '.wav',
  '.webm',
  '.ogg',
] as const;

/** Value for an <input type="file" accept> that matches the allowlist. */
export const DOCUMENT_ACCEPT = DOCUMENT_EXTENSIONS.join(',');

/** Largest upload the server takes. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Why a file can't be uploaded, checked before sending it; null when it looks fine. */
export function uploadProblem(file: File): string | null {
  const dot = file.name.lastIndexOf('.');
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!(DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) {
    return `Files of type ${extension || 'unknown'} can't be uploaded. Use a PDF, image, Word document or text file.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) return 'Files must be under 50 MB.';
  if (file.size === 0) return 'This file is empty.';
  return null;
}

/** A friendly message for a failed upload (413 too large, 415 wrong type, anything else). */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const serverMessage = typeof error.detail === 'string' ? error.detail : null;
    if (error.status === 413) return serverMessage ?? 'This file is too large. Files must be under 50 MB.';
    if (error.status === 415) return serverMessage ?? "This type of file can't be uploaded.";
    return error.message;
  }
  return error instanceof Error ? error.message : 'The upload failed. Please try again.';
}

/** Documents shared with a client and files they uploaded (staff side). */
export const filesApi = {
  forClient: (clientId: number) => api<StoredFile[]>(`/clients/${clientId}/files`),
  share: (clientId: number, file: File, notify: boolean) =>
    uploadFile<StoredFile>(`/clients/${clientId}/files`, file, { fields: { notify: String(notify) } }),
  download: (file: StoredFile) => downloadFile(`/files/${file.id}`, { filename: file.filename }),
  stopSharing: (fileId: number) => api<void>(`/files/${fileId}`, { method: 'DELETE' }),
};

export const fileKeys = {
  forClient: (clientId: number) => ['files', 'client', clientId] as const,
};

/** The signed-in client's shared documents and uploads. */
export const portalFilesApi = {
  list: () => api<StoredFile[]>('/portal/files', { realm: 'client' }),
  upload: (file: File) => uploadFile<StoredFile>('/portal/files', file, { realm: 'client' }),
  download: (file: StoredFile) =>
    downloadFile(`/portal/files/${file.id}`, { realm: 'client', filename: file.filename }),
};

export const portalFileKeys = {
  list: ['portal', 'files'] as const,
};
