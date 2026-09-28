import type { ImportJob, ImportKindInfo, ImportPreview } from '../../../api/imports';

/** Synthetic data only. */
export const KINDS: ImportKindInfo[] = [
  {
    kind: 'export_zip',
    label: 'Complete export (zip)',
    description: 'Documents, contacts and secure messages for every client.',
    extensions: ['.zip'],
    fields: [],
  },
  {
    kind: 'client_details',
    label: 'Client details report',
    description: 'Names, contact details, status and clinician.',
    extensions: ['.csv', '.xlsx'],
    fields: [
      { name: 'name', label: 'Client name', required: true },
      { name: 'email', label: 'Email', required: false },
      { name: 'clinician', label: 'Clinician', required: false },
    ],
  },
  {
    kind: 'attendance',
    label: 'Attendance report',
    description: 'Past sessions with their status.',
    extensions: ['.csv', '.xlsx'],
    fields: [
      { name: 'client', label: 'Client', required: true },
      { name: 'date_of_service', label: 'Date of service', required: true },
      { name: 'status', label: 'Status', required: false },
    ],
  },
];

export function importJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: 7,
    source: 'simplepractice',
    status: 'uploaded',
    created_by_id: 1,
    created_at: '2026-09-20T14:00:00Z',
    started_at: null,
    finished_at: null,
    file_count: 0,
    files: [],
    mapping: {},
    options: {
      default_clinician_id: null,
      clinicians: {},
      matches: {},
      existing: {},
      create_missing_clients: true,
      import_contacts: true,
      import_insurance: true,
      import_appointments: true,
      import_documents: true,
      import_balances: true,
      zip_password_set: false,
    },
    preview: null,
    result: null,
    error: '',
    ...overrides,
  };
}

export function preview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    analyzed_at: '2026-09-20T14:05:00Z',
    counts: {
      clients_new: 12,
      clients_existing: 2,
      contacts: 5,
      insurance_policies: 4,
      clients_with_diagnoses: 3,
      appointments: 240,
      future_appointments_skipped: 6,
      documents: 180,
      psychotherapy_notes: 9,
      secure_messages: 11,
      documents_skipped: 2,
      balances: 3,
      balance_total_cents: 45000,
    },
    files: [
      {
        file_id: 2,
        kind: 'client_details',
        filename: 'client-details.csv',
        rows: 14,
        columns: { name: 'Client', email: 'Email', clinician: 'Clinician' },
        missing_required: [],
        sample: [{ name: 'Casey Morgan', email: 'casey@example.com' }],
      },
    ],
    folders: [{ name: 'Medical Records', clients: 10, files: 150 }],
    matches: [
      {
        id: 'm1',
        name: 'Katie Doe',
        sources: ['Attendance report'],
        reason: 'similar_name',
        candidates: [{ key: 'katherine doe|1990-02-03', name: 'Katherine Doe', detail: 'Born Feb 3, 1990' }],
        decision: null,
      },
    ],
    existing: [
      {
        key: 'sam lee|',
        name: 'Sam Lee',
        detail: 'sam@example.com',
        candidates: [{ key: '41', name: 'Sam Lee', detail: 'Added Jan 2026' }],
        decision: null,
      },
    ],
    clinicians: [
      { key: 'dana lee', name: 'Dana Lee', clients: 10, appointments: 200, staff_id: 1, matched: true, invite: null },
      { key: 'robin park', name: 'Robin Park', clients: 4, appointments: 40, staff_id: null, matched: false, invite: null },
    ],
    warnings: [{ code: 'bad_date', message: '3 rows in the Attendance report have an unreadable date.', count: 3 }],
    ...overrides,
  };
}
