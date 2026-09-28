import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../api/auth';
import type { ImportJob } from '../../../api/imports';
import type { TeamMember } from '../../../api/team';
import { WithSession, testSession } from '../../../test/session';
import { ToastProvider } from '../../../ui/Toast';
import { settingsTabsFor } from '../settingsTabs';
import { KINDS, importJob, preview } from './import.fixture';
import { ImportSettings } from './ImportSettings';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

const api = vi.hoisted(() => ({
  kinds: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  upload: vi.fn(),
  removeFile: vi.fn(),
  update: vi.fn(),
  analyze: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
}));
const teamList = vi.hoisted(() => vi.fn());

vi.mock('../../../api/imports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/imports')>();
  return { ...actual, importsApi: api };
});
vi.mock('../../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, list: teamList } };
});
vi.mock('../../../lib/usePublicConfig', () => ({ usePublicConfig: () => ({ import_max_bytes: 1024 * 1024 }) }));

const TEAM = [
  { id: 1, display_name: 'Dana Lee, LCSW', is_clinician: true, status: 'active' },
  { id: 9, display_name: 'Robin Park, LPC', is_clinician: true, status: 'active' },
  { id: 12, display_name: 'Pat Biller', is_clinician: false, status: 'active' },
] as TeamMember[];

const ZIP = {
  file_id: 1,
  kind: 'export_zip' as const,
  detected_kind: 'export_zip' as const,
  filename: 'export.zip',
  size_bytes: 5_000_000,
  headers: [],
  encrypted: true,
};
const DETAILS = {
  file_id: 2,
  kind: 'client_details' as const,
  detected_kind: 'client_details' as const,
  filename: 'client-details.csv',
  size_bytes: 2048,
  headers: ['Client', 'Email', 'Clinician'],
  encrypted: false,
};

function renderImport(job: ImportJob | null, session: Session = testSession()) {
  if (job) api.get.mockResolvedValue(job);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const path = job ? `/portal/settings?tab=import&import=${job.id}` : '/portal/settings?tab=import';
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={session}>
          <MemoryRouter future={ROUTER_FUTURE} initialEntries={[path]}>
            {ui}
          </MemoryRouter>
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>
  );
  return render(wrap(<ImportSettings />));
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  teamList.mockReset().mockResolvedValue(TEAM);
  api.kinds.mockResolvedValue(KINDS);
  api.list.mockResolvedValue([]);
});

describe('import tab', () => {
  it('is shown only to people who manage the practice', () => {
    expect(settingsTabsFor(testSession())).toContain('import');
    expect(
      settingsTabsFor(testSession({ staff: { role: 'biller', is_clinician: false }, capabilities: ['billing_all'] })),
    ).not.toContain('import');
    expect(settingsTabsFor(testSession({ staff: { role: 'clinician' }, capabilities: ['manage_practice'] }))).toContain(
      'import',
    );
  });
});

describe('ImportSettings overview', () => {
  it('explains what to download, lists past imports and starts a new import', async () => {
    api.list.mockResolvedValue([{ ...importJob({ status: 'completed', file_count: 3 }) }]);
    api.create.mockResolvedValue(importJob({ id: 8 }));
    api.get.mockResolvedValue(importJob({ id: 8 }));
    renderImport(null);

    expect(await screen.findByText('Client details report')).toBeInTheDocument();
    expect(screen.getByText(/Settings > Practice > Data export/)).toBeInTheDocument();
    expect(screen.getByText(/no appointment times or lengths/)).toBeInTheDocument();
    expect(screen.getByText(/Psychotherapy Notes are visible only to the client's primary clinician/)).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Completed')).toBeInTheDocument();
    expect(within(table).getByText('3 files')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Start an import' }));
    expect(api.create).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Upload your SimplePractice files' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(8);
  });
});

describe('upload step', () => {
  const job = importJob({
    files: [ZIP, DETAILS],
    file_count: 2,
    mapping: { '2': { name: 'Client', email: 'Email', clinician: null } },
  });

  it('shows each file with its kind and lets the kind be corrected', async () => {
    api.update.mockResolvedValue(job);
    renderImport(job);
    const kind = await screen.findByRole('combobox', { name: 'What client-details.csv is' });
    expect(kind).toHaveValue('client_details');
    await userEvent.selectOptions(kind, 'attendance');
    expect(api.update).toHaveBeenCalledWith(7, { files: [{ file_id: 2, kind: 'attendance' }] });
  });

  it('saves a mapping change for the file', async () => {
    api.update.mockResolvedValue(job);
    renderImport(job);
    await userEvent.click(await screen.findByRole('button', { name: /Columns in client-details.csv/ }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Clinician' }), 'Clinician');
    expect(api.update).toHaveBeenCalledWith(7, {
      mapping: { '2': { name: 'Client', email: 'Email', clinician: 'Clinician' } },
    });
  });

  it('accepts First name and Last name columns in place of the client name', async () => {
    const list = {
      file_id: 3,
      kind: 'client_list' as const,
      detected_kind: 'client_list' as const,
      filename: 'Client List.csv',
      size_bytes: 4096,
      headers: ['First Name', 'Last Name', 'Email'],
      encrypted: false,
    };
    api.kinds.mockResolvedValue([
      ...KINDS,
      {
        kind: 'client_list',
        label: 'Client List (from SimplePractice support)',
        description: 'Insurance details, diagnoses and billing type.',
        extensions: ['.csv'],
        fields: [
          { name: 'name', label: 'Name', required: true },
          { name: 'first_name', label: 'First name', required: false },
          { name: 'last_name', label: 'Last name', required: false },
        ],
      },
    ]);
    renderImport(
      importJob({
        files: [list],
        file_count: 1,
        mapping: { '3': { name: null, first_name: 'First Name', last_name: 'Last Name' } },
      }),
    );

    expect(await screen.findByText('Required columns matched')).toBeInTheDocument();
    expect(screen.queryByText(/Match Name/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze files' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /Columns in Client List.csv/ }));
    expect(screen.getByText('Or match First name and Last name.')).toBeInTheDocument();
  });

  it('asks for the zip password before analyzing', async () => {
    const saved = importJob({ ...job, options: { ...job.options, zip_password_set: true } });
    api.update.mockResolvedValue(saved);
    api.analyze.mockResolvedValue({ ...saved, status: 'analyzing' });
    renderImport(job);

    expect(await screen.findByText('Enter the password for export.zip.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze files' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Zip password'), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }));
    expect(api.update).toHaveBeenCalledWith(7, { zip_password: 'hunter22' });
    expect(await screen.findByText('Password saved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Analyze files' }));
    expect(api.analyze).toHaveBeenCalledWith(7);
    expect(await screen.findByText('Analyzing your files…')).toBeInTheDocument();
  });

  it('uploads chosen files with progress and rejects unsupported ones', async () => {
    let finish: (value: ImportJob) => void = () => undefined;
    api.upload.mockImplementation(
      (_id: number, _file: File, options: { onProgress?: (fraction: number) => void }) =>
        new Promise<ImportJob>((resolve) => {
          options.onProgress?.(0.4);
          finish = resolve;
        }),
    );
    renderImport(importJob());
    const input = await screen.findByLabelText('Choose SimplePractice files');
    await userEvent.upload(input, [new File(['a,b'], 'attendance.csv', { type: 'text/csv' })]);

    expect(api.upload).toHaveBeenCalledWith(7, expect.any(File), expect.any(Object));
    const progress = await screen.findByRole('progressbar', { name: 'Uploading attendance.csv' });
    expect(progress).toHaveAttribute('aria-valuenow', '40');

    finish(importJob({ files: [{ ...DETAILS, file_id: 3, kind: 'attendance', filename: 'attendance.csv' }] }));
    expect(await screen.findByRole('combobox', { name: 'What attendance.csv is' })).toHaveValue('attendance');
    expect(screen.queryByRole('progressbar', { name: 'Uploading attendance.csv' })).not.toBeInTheDocument();

    await userEvent.upload(input, [new File(['x'], 'notes.xls')], { applyAccept: false });
    expect(await screen.findByText(/notes.xls: save it as .xlsx or .csv first/)).toBeInTheDocument();
    expect(api.upload).toHaveBeenCalledTimes(1);
  });
});

describe('review step', () => {
  const ready = importJob({
    status: 'ready',
    files: [DETAILS],
    file_count: 1,
    mapping: { '2': { name: 'Client', email: 'Email', clinician: 'Clinician' } },
    preview: preview(),
  });

  it('shows the totals, warnings and possible matches', async () => {
    renderImport(ready);
    expect(await screen.findByText("Here's what we found")).toBeInTheDocument();
    expect(screen.getByText('New clients').nextSibling).toHaveTextContent('12');
    expect(screen.getByText('6 future appointments skipped')).toBeInTheDocument();
    expect(screen.getByText('$450.00 in total')).toBeInTheDocument();
    expect(screen.getByText('3 rows in the Attendance report have an unreadable date.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Same person as Katherine Doe Born Feb 3, 1990' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'A different person (keep separate)' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Add as a new client' })).toBeChecked();
  });

  it('saves choices and analyzes again', async () => {
    api.update.mockResolvedValue(ready);
    api.analyze.mockResolvedValue({ ...ready, status: 'analyzing' });
    renderImport(ready);
    await userEvent.click(await screen.findByRole('radio', { name: 'Same person as Katherine Doe Born Feb 3, 1990' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Update Sam Lee Added Jan 2026' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Opening balances/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save and update preview' }));

    await waitFor(() => expect(api.analyze).toHaveBeenCalledWith(7));
    const { options } = api.update.mock.calls[0][1] as { options: ImportJob['options'] };
    expect(options.matches).toEqual({ m1: 'katherine doe|1990-02-03' });
    expect(options.existing).toEqual({ 'sam lee|': 41 });
    expect(options.import_balances).toBe(false);
    expect(options).not.toHaveProperty('zip_password_set');
  });

  it('needs a clinician for everyone before starting, then confirms', async () => {
    api.update.mockResolvedValue(ready);
    api.start.mockResolvedValue({ ...ready, status: 'importing', result: null });
    renderImport(ready);

    expect(await screen.findByText('Choose a Synari clinician for Robin Park, or a default clinician.')).toBeInTheDocument();
    const startButton = screen.getByRole('button', { name: 'Start import' });
    expect(startButton).toBeDisabled();

    const robin = screen.getByRole('combobox', { name: 'Synari clinician for Robin Park' });
    expect(await within(robin).findByRole('option', { name: 'Robin Park, LPC' })).toBeInTheDocument();
    expect(within(robin).queryByRole('option', { name: 'Pat Biller' })).not.toBeInTheDocument();
    await userEvent.selectOptions(robin, 'staff:9');
    expect(startButton).toBeEnabled();

    await userEvent.click(startButton);
    const dialog = await screen.findByRole('dialog', { name: 'Start the import?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start import' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith(7));
    const { options } = api.update.mock.calls[0][1] as { options: ImportJob['options'] };
    expect(options.clinicians).toEqual({ 'dana lee': { staff_id: 1 }, 'robin park': { staff_id: 9 } });
    expect(await screen.findByRole('progressbar', { name: 'Import progress' })).toBeInTheDocument();
  });

  it('invites a new clinician only for people who manage the team', async () => {
    const { unmount } = renderImport(ready);
    const robin = await screen.findByRole('combobox', { name: 'Synari clinician for Robin Park' });
    await userEvent.selectOptions(robin, 'invite');
    expect(screen.getByLabelText(/First name/)).toHaveValue('Robin');
    expect(screen.getByLabelText(/Last name/)).toHaveValue('Park');
    unmount();

    renderImport(ready, testSession({ capabilities: ['manage_practice', 'view_all_clients'] }));
    const again = await screen.findByRole('combobox', { name: 'Synari clinician for Robin Park' });
    expect(within(again).queryByRole('option', { name: /Invite a new clinician/ })).not.toBeInTheDocument();
  });
});

describe('importing and results', () => {
  it('shows live progress and can stop the import', async () => {
    const importing = importJob({
      status: 'importing',
      started_at: '2026-09-20T14:10:00Z',
      preview: preview(),
      result: { phase: 'documents', processed: 30, total: 120, created: {}, updated: {}, skipped: {}, warnings: [] },
    });
    api.cancel.mockResolvedValue({ ...importing, status: 'canceled' });
    renderImport(importing);

    expect(await screen.findByText('Importing documents')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Import progress' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('30 of 120 records processed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Stop import' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop this import?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop import' }));
    expect(api.cancel).toHaveBeenCalledWith(7);
    expect(await screen.findByText('This import was canceled')).toBeInTheDocument();
  });

  it('summarizes a completed import with links onward', async () => {
    renderImport(
      importJob({
        status: 'completed',
        started_at: '2026-09-20T14:10:00Z',
        finished_at: '2026-09-20T14:20:00Z',
        preview: preview(),
        result: {
          phase: 'done',
          processed: 120,
          total: 120,
          created: { client: 12, appointment: 240, document: 180 },
          updated: { client: 2 },
          skipped: { document: 2 },
          warnings: [{ code: 'unsupported', message: '2 files had types Synari can’t store.', count: 2 }],
        },
      }),
    );
    expect(await screen.findByText('Import complete')).toBeInTheDocument();
    const clients = screen.getByRole('row', { name: /Clients/ });
    expect(within(clients).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Clients', '12', '2', '0']);
    expect(screen.getByRole('row', { name: /Past appointments/ })).toHaveTextContent('240');
    expect(screen.getByText('2 files had types Synari can’t store.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View clients' })).toHaveAttribute('href', '/portal/clients');
    expect(screen.getByRole('link', { name: 'Open the calendar' })).toHaveAttribute('href', '/portal/calendar');
    expect(screen.getByRole('link', { name: 'Review balances' })).toHaveAttribute('href', '/portal/billing');
    expect(screen.queryByRole('button', { name: /Discard import|Stop import/ })).not.toBeInTheDocument();
  });

  it('explains a failed analysis and keeps the files editable', async () => {
    renderImport(importJob({ status: 'failed', files: [DETAILS], error: 'The password for export.zip is incorrect.' }));
    expect(await screen.findByText("We couldn't read your files")).toBeInTheDocument();
    expect(screen.getByText('The password for export.zip is incorrect.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze files' })).toBeInTheDocument();
  });

  it('retries a failed import', async () => {
    const failed = importJob({
      status: 'failed',
      started_at: '2026-09-20T14:10:00Z',
      preview: preview(),
      error: 'The export zip is corrupt.',
      result: { phase: 'documents', processed: 10, total: 100, created: { client: 12 }, updated: {}, skipped: {}, warnings: [] },
    });
    api.start.mockResolvedValue({ ...failed, status: 'importing', error: '' });
    renderImport(failed);
    expect(await screen.findByText('The import stopped')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try the import again' }));
    expect(api.start).toHaveBeenCalledWith(7);
    expect(await screen.findByRole('progressbar', { name: 'Import progress' })).toBeInTheDocument();
  });
});
