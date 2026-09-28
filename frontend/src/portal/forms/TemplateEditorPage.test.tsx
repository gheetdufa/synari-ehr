import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Session } from '../../api/auth';
import { formsApi, type FormTemplate } from '../../api/forms';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import TemplateEditorPage from './TemplateEditorPage';

vi.mock('../../api/forms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/forms')>();
  return {
    ...actual,
    formsApi: { ...actual.formsApi, template: vi.fn(), updateTemplate: vi.fn(), createTemplate: vi.fn() },
  };
});

const api = vi.mocked(formsApi);

const TEMPLATE: FormTemplate = {
  id: 3,
  kind: 'intake',
  name: 'Check-in',
  description: '',
  requires_signature: false,
  library_key: null,
  read_only: false,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  scoring: null,
  fields: [
    { id: 'welcome', type: 'heading', label: 'Welcome' },
    { id: 'mood', type: 'short_text', label: 'How are you?', required: false, help: '', maps_to: null, options: null },
  ],
};

function renderEditor(templateId = 3, session: Session = testSession()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter
            initialEntries={[`/portal/forms/templates/${templateId}`]}
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <Routes>
              <Route path="/portal/forms/templates/:templateId" element={<TemplateEditorPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

function fieldList() {
  return screen.getByRole('list', { name: 'Form fields' });
}

describe('TemplateEditorPage', () => {
  beforeEach(() => {
    api.template.mockResolvedValue(TEMPLATE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('adds a question, generates its id from the label and saves the template', async () => {
    const user = userEvent.setup();
    api.updateTemplate.mockImplementation(async (_, changes) => ({ ...TEMPLATE, ...changes }) as FormTemplate);
    renderEditor();

    await screen.findByRole('list', { name: 'Form fields' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^Yes \/ No Yes or no/ }));
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'OK to text you?');
    await user.click(screen.getByRole('checkbox', { name: /Required/ }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateTemplate).toHaveBeenCalledTimes(1));
    const [templateId, body] = api.updateTemplate.mock.calls[0];
    expect(templateId).toBe(3);
    expect(body.fields?.[2]).toEqual({ id: 'ok_to_text_you', type: 'yes_no', label: 'OK to text you?', required: true });
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
  });

  it('blocks saving and points to the problem when a question has no text', async () => {
    const user = userEvent.setup();
    renderEditor();

    await screen.findByRole('list', { name: 'Form fields' });
    await user.click(screen.getByRole('button', { name: /^Short answer One line of text/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(api.updateTemplate).not.toHaveBeenCalled();
    expect(await screen.findByText('Add the question')).toBeInTheDocument();
    expect(screen.getByText('1 to fix')).toBeInTheDocument();
  });

  it('reorders fields with the arrow buttons and Alt+Arrow keys', async () => {
    const user = userEvent.setup();
    renderEditor();

    await screen.findByRole('list', { name: 'Form fields' });
    const summaries = () => within(fieldList()).getAllByRole('button', { expanded: false }).map((button) => button.textContent);
    await user.click(screen.getByRole('button', { name: 'Move Welcome down' }));
    expect(summaries()[0]).toContain('How are you?');

    const moodToggle = within(fieldList()).getAllByRole('button', { expanded: false })[0];
    moodToggle.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(summaries()[0]).toContain('Welcome');
    expect(screen.getByText(/Moved “How are you\?” to position 2 of 2/)).toBeInTheDocument();
  });

  it('opens built-in scored assessments read-only with an explanation', async () => {
    api.template.mockResolvedValue({
      ...TEMPLATE,
      kind: 'assessment',
      name: 'PHQ-9',
      library_key: 'phq9',
      read_only: true,
      scoring: {
        method: 'sum',
        items: ['mood'],
        max_score: 3,
        bands: [{ min: 0, max: 3, label: 'Minimal' }],
        flags: [{ item: 'mood', min: 1, reason: 'Mood endorsed' }],
      },
    });
    renderEditor();

    expect(await screen.findByText("This assessment can't be edited")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Make an editable copy' })).toBeInTheDocument();
    expect(screen.getByText(/scored 1 or more/)).toBeInTheDocument();
  });

  it('shows templates read-only to staff who do not maintain them', async () => {
    const biller = testSession({
      staff: { role: 'biller', is_clinician: false },
      capabilities: ['view_all_clients', 'billing_all', 'view_reports'],
    });
    renderEditor(3, biller);

    expect(await screen.findByText('View only')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Check-in' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Form fields' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make an editable copy' })).toBeNull();
    expect(screen.queryByText('Built-in')).toBeNull();
  });

  it('shows a not-found state for ids that are not numbers', async () => {
    renderEditor(Number.NaN);
    expect(await screen.findByText('Form template not found')).toBeInTheDocument();
    expect(api.template).not.toHaveBeenCalled();
  });
});
