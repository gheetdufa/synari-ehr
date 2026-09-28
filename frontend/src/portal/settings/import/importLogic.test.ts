import { describe, expect, it } from 'vitest';
import type { ImportFile, ImportKindInfo } from '../../../api/imports';
import { KINDS, importJob, preview } from './import.fixture';
import {
  analyzeBlockers,
  importFileProblem,
  initialOptions,
  missingRequired,
  phaseLabel,
  progressPercent,
  resultRows,
  startBlockers,
  withMappedColumn,
} from './importLogic';

const DETAILS: ImportFile = {
  file_id: 2,
  kind: 'client_details',
  detected_kind: 'client_details',
  filename: 'client-details.csv',
  size_bytes: 2048,
  headers: ['Client', 'Email'],
  encrypted: false,
};

const ZIP: ImportFile = {
  file_id: 1,
  kind: 'export_zip',
  detected_kind: 'export_zip',
  filename: 'export.zip',
  size_bytes: 10_000,
  headers: [],
  encrypted: true,
};

describe('importFileProblem', () => {
  const GB = 1024 ** 3;
  it.each([
    ['export.zip', 10, null],
    ['clients.CSV', 10, null],
    ['report.xlsx', 10, null],
    ['report.xls', 10, 'report.xls: save it as .xlsx or .csv first'],
    ['notes.pdf', 10, 'notes.pdf: use the SimplePractice export zip'],
    ['empty.csv', 0, 'empty.csv is empty.'],
  ])('checks %s', (name, size, problem) => {
    const file = new File(['x'.repeat(size)], name);
    const result = importFileProblem(file, 2 * GB);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toContain(problem);
  });

  it('rejects files over the limit', () => {
    expect(importFileProblem(new File(['12345'], 'big.zip'), 4)).toBe('big.zip is larger than 4 B.');
  });
});

describe('analyzeBlockers', () => {
  it('needs at least one file', () => {
    expect(analyzeBlockers(importJob(), KINDS)).toEqual(['Upload at least one SimplePractice file.']);
  });

  it('asks for unrecognized kinds, the zip password and required columns', () => {
    const job = importJob({
      files: [ZIP, DETAILS, { ...DETAILS, file_id: 3, kind: null, detected_kind: null, filename: 'mystery.csv' }],
      mapping: { '2': { name: null, email: 'Email' } },
    });
    expect(analyzeBlockers(job, KINDS)).toEqual([
      'Enter the password for export.zip.',
      'Match Client name to a column in client-details.csv.',
      'Choose what mystery.csv is.',
    ]);
  });

  it('is empty when everything is ready', () => {
    const job = importJob({
      files: [ZIP, DETAILS],
      mapping: { '2': { name: 'Client' } },
      options: { ...importJob().options, zip_password_set: true },
    });
    expect(analyzeBlockers(job, KINDS)).toEqual([]);
  });
});

describe('missingRequired', () => {
  const CLIENT_LIST: ImportFile = {
    file_id: 4,
    kind: 'client_list',
    detected_kind: 'client_list',
    filename: 'Client List.csv',
    size_bytes: 4096,
    headers: ['First Name', 'Last Name', 'Email'],
    encrypted: false,
  };
  const LIST_KIND: ImportKindInfo = {
    kind: 'client_list',
    label: 'Client List',
    description: '',
    extensions: ['.csv'],
    fields: [
      { name: 'name', label: 'Name', required: true },
      { name: 'first_name', label: 'First name', required: false },
      { name: 'last_name', label: 'Last name', required: false },
    ],
  };

  it.each([
    [{ name: 'Name' }, []],
    [{ name: null, first_name: 'First Name', last_name: 'Last Name' }, []],
    [{ first_name: 'First Name' }, ['Name']],
    [{ first_name: 'First Name', last_name: null }, ['Name']],
    [{}, ['Name']],
  ])('takes a name or both first and last names (%o)', (columns, missing) => {
    expect(missingRequired(CLIENT_LIST, { '4': columns }, [LIST_KIND])).toEqual(missing);
  });

  it('lets first and last names stand in only for the client name', () => {
    const attendance: ImportFile = { ...DETAILS, file_id: 5, kind: 'attendance', filename: 'attendance.csv' };
    expect(missingRequired(attendance, { '5': { first_name: 'First', last_name: 'Last' } }, KINDS)).toEqual([
      'Date of service',
    ]);
    const job = importJob({ files: [CLIENT_LIST], mapping: { '4': { first_name: 'First Name', last_name: 'Last Name' } } });
    expect(analyzeBlockers(job, [LIST_KIND])).toEqual([]);
  });
});

describe('withMappedColumn', () => {
  it("changes one field and keeps the rest of every file's mapping", () => {
    const mapping = { '2': { name: 'Client', email: 'Email' }, '3': { client: 'Client' } };
    expect(withMappedColumn(mapping, 2, 'email', null)).toEqual({
      '2': { name: 'Client', email: null },
      '3': { client: 'Client' },
    });
    expect(withMappedColumn({}, 4, 'status', 'Status')).toEqual({ '4': { status: 'Status' } });
  });
});

describe('initialOptions', () => {
  it("fills in the analysis's suggestions without overriding saved choices", () => {
    const job = importJob({
      status: 'ready',
      options: { ...importJob().options, clinicians: { 'robin park': { staff_id: 9 } }, matches: { m1: '' } },
      preview: preview({
        matches: [{ ...preview().matches[0], decision: 'katherine doe|1990-02-03' }],
        existing: [{ ...preview().existing[0], decision: 41 }],
      }),
    });
    const options = initialOptions(job);
    expect(options.matches).toEqual({ m1: '' });
    expect(options.existing).toEqual({ 'sam lee|': 41 });
    expect(options.clinicians).toEqual({ 'dana lee': { staff_id: 1 }, 'robin park': { staff_id: 9 } });
    expect(options).not.toHaveProperty('zip_password_set');
  });
});

describe('startBlockers', () => {
  const options = initialOptions(importJob({ preview: preview() }));

  it('needs a default clinician for unmapped SimplePractice clinicians', () => {
    expect(startBlockers(preview(), options)).toEqual([
      'Choose a Synari clinician for Robin Park, or a default clinician.',
    ]);
    expect(startBlockers(preview(), { ...options, default_clinician_id: 1 })).toEqual([]);
  });

  it('needs complete invitations', () => {
    const inviting = {
      ...options,
      clinicians: { ...options.clinicians, 'robin park': { invite: { first_name: 'Robin', last_name: 'Park', email: '' } } },
    };
    expect(startBlockers(preview(), inviting)).toEqual(['Enter a name and email to invite a clinician for Robin Park.']);
  });
});

describe('progress and results', () => {
  it.each([
    [0, 0, 0],
    [5, 20, 25],
    [20, 20, 100],
    [30, 20, 100],
  ])('%i of %i is %i%%', (processed, total, percent) => {
    expect(progressPercent(processed, total)).toBe(percent);
  });

  it('labels phases', () => {
    expect(phaseLabel('')).toBe('Starting');
    expect(phaseLabel('documents')).toBe('Importing documents');
    expect(phaseLabel('something_new')).toBe('Something new');
  });

  it('orders result rows with known kinds first', () => {
    const rows = resultRows({
      created: { appointment: 20, client: 5, widget: 1 },
      updated: { client: 2 },
      skipped: { document: 3 },
    });
    expect(rows.map((row) => row.label)).toEqual(['Clients', 'Past appointments', 'Documents', 'Widget']);
    expect(rows[0]).toMatchObject({ created: 5, updated: 2, skipped: 0 });
  });
});
