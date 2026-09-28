import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '../../api/auth';
import { formsApi, type TemplateSummary } from '../../api/forms';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import FormsPage from './FormsPage';

vi.mock('../../api/forms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/forms')>();
  return { ...actual, formsApi: { ...actual.formsApi, templates: vi.fn() } };
});

const templates = vi.mocked(formsApi.templates);

const INTAKE: TemplateSummary = {
  id: 1,
  kind: 'intake',
  name: 'Intake Questionnaire',
  description: '',
  requires_signature: false,
  library_key: null,
  read_only: false,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const PRACTICE_MANAGER = testSession({
  staff: { role: 'practice_manager', is_clinician: false },
  capabilities: ['manage_team', 'manage_practice', 'view_all_clients', 'schedule_all', 'billing_all', 'view_reports'],
});
const BILLER = testSession({
  staff: { role: 'biller', is_clinician: false },
  capabilities: ['view_all_clients', 'billing_all', 'view_reports'],
});
const SCHEDULER = testSession({
  staff: { role: 'scheduler', is_clinician: false },
  capabilities: ['view_all_clients', 'schedule_all'],
});

function renderPage(session: Session) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <FormsPage />
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('FormsPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['a clinician', true, testSession()],
    ['a practice manager', true, PRACTICE_MANAGER],
    ['a biller', false, BILLER],
    ['a scheduler', false, SCHEDULER],
  ])('lets %s change templates: %s', async (_who, canEdit, session) => {
    templates.mockResolvedValue([INTAKE]);
    renderPage(session);

    const row = (await screen.findByRole('link', { name: 'Intake Questionnaire' })).closest('li') as HTMLElement;
    const open = within(row).getByRole('link', { name: `${canEdit ? 'Edit' : 'View'} Intake Questionnaire` });
    expect(open).toHaveAttribute('href', '/portal/forms/templates/1');
    const actions = [
      screen.queryByRole('button', { name: 'New template' }),
      screen.queryByRole('button', { name: 'Add from library' }),
      within(row).queryByRole('button', { name: 'Duplicate Intake Questionnaire' }),
      within(row).queryByRole('button', { name: 'Archive Intake Questionnaire' }),
    ];
    for (const action of actions) {
      if (canEdit) expect(action).toBeInTheDocument();
      else expect(action).not.toBeInTheDocument();
    }
  });

  it("doesn't offer actions a non-editor can't take when there are no templates", async () => {
    templates.mockResolvedValue([]);
    renderPage(BILLER);

    expect(await screen.findByText('No form templates yet')).toBeInTheDocument();
    expect(screen.getByText(/Once a clinician or practice manager adds/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
