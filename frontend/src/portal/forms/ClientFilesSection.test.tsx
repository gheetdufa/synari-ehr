import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientDetail } from '../../api/clients';
import type { StoredFile } from '../../api/files';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { ClientFilesSection, importedCategories } from './ClientFilesSection';

const mocks = vi.hoisted(() => ({ forClient: vi.fn(), team: vi.fn() }));

vi.mock('../../api/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/files')>();
  return { ...actual, filesApi: { ...actual.filesApi, forClient: mocks.forClient } };
});
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, list: mocks.team } };
});

const CLIENT = { id: 9, first_name: 'Alex', last_name: 'Rivera' } as ClientDetail;

function file(overrides: Partial<StoredFile>): StoredFile {
  return {
    id: 1,
    client_id: 9,
    purpose: 'shared_document',
    filename: 'npp.pdf',
    content_type: 'application/pdf',
    size_bytes: 2048,
    uploaded_by: 'staff',
    uploaded_by_staff_id: 1,
    shared_with_client: true,
    category: '',
    created_at: '2026-09-01T12:00:00Z',
    ...overrides,
  };
}

const FILES = [
  file({ id: 1 }),
  file({
    id: 2,
    purpose: 'imported_document',
    filename: 'intake-2024.pdf',
    category: 'Medical Records',
    shared_with_client: false,
  }),
  file({
    id: 3,
    purpose: 'imported_document',
    filename: 'session-notes.pdf',
    category: 'Psychotherapy Notes',
    shared_with_client: false,
  }),
];

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={testSession()}>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <ClientFilesSection client={CLIENT} timeZone="America/New_York" />
          </MemoryRouter>
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.forClient.mockReset().mockResolvedValue(FILES);
  mocks.team.mockReset().mockResolvedValue([]);
});

describe('ClientFilesSection with imported documents', () => {
  it('labels imported documents with their SimplePractice folder', async () => {
    renderSection();
    const imported = (await screen.findByText('intake-2024.pdf')).closest('li')!;
    expect(within(imported).getByText('Imported · Medical Records')).toBeInTheDocument();
    expect(within(imported).getByText(/Imported from SimplePractice on/)).toBeInTheDocument();
    expect(within(imported).queryByRole('button', { name: /Stop sharing/ })).not.toBeInTheDocument();

    const note = screen.getByText('session-notes.pdf').closest('li')!;
    expect(within(note).getByText(/Psychotherapy note · only you can see it/)).toBeInTheDocument();

    const shared = screen.getByText('npp.pdf').closest('li')!;
    expect(within(shared).getByText('Shared')).toBeInTheDocument();
    expect(within(shared).getByRole('button', { name: 'Stop sharing npp.pdf' })).toBeInTheDocument();
  });

  it('filters by imported folder', async () => {
    renderSection();
    const filter = await screen.findByRole('combobox', { name: 'Show' });
    await userEvent.selectOptions(filter, 'Imported: Medical Records');
    expect(screen.getByText('intake-2024.pdf')).toBeInTheDocument();
    expect(screen.queryByText('npp.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('session-notes.pdf')).not.toBeInTheDocument();

    await userEvent.selectOptions(filter, 'Shared and uploaded files');
    expect(screen.getByText('npp.pdf')).toBeInTheDocument();
    expect(screen.queryByText('intake-2024.pdf')).not.toBeInTheDocument();
  });

  it('only offers the filter when there are imported documents', async () => {
    mocks.forClient.mockResolvedValue([FILES[0]]);
    renderSection();
    expect(await screen.findByText('npp.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Show' })).not.toBeInTheDocument();
    expect(importedCategories(FILES)).toEqual(['Medical Records', 'Psychotherapy Notes']);
  });
});
