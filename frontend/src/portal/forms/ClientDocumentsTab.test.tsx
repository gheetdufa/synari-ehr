import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import { clientsApi, type ClientDetail } from '../../api/clients';
import { filesApi } from '../../api/files';
import { formsApi, type ClientFormDetail, type ClientFormSummary, type TemplateSummary } from '../../api/forms';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import ClientDocumentsTab from './ClientDocumentsTab';

vi.mock('../../api/forms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/forms')>();
  return {
    ...actual,
    formsApi: {
      ...actual.formsApi,
      clientForms: vi.fn(),
      clientForm: vi.fn(),
      templates: vi.fn(),
      share: vi.fn(),
      remind: vi.fn(),
      withdraw: vi.fn(),
    },
  };
});
vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, get: vi.fn() } };
});
vi.mock('../../api/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/files')>();
  return { ...actual, filesApi: { ...actual.filesApi, forClient: vi.fn() } };
});

const forms = vi.mocked(formsApi);

const CLIENT = {
  id: 9,
  first_name: 'Alex',
  last_name: 'Rivera',
  preferred_name: '',
  email: 'alex@example.com',
  status: 'active',
  portal_enabled: true,
  care_team: [{ staff_id: 1, name: 'Dana Lee, LCSW', is_primary: true }],
  access: { clinical: true, billing: true },
} as ClientDetail;

/** The client as staff outside the care team without clinical access see them. */
const PROFILE_ONLY_CLIENT: ClientDetail = { ...CLIENT, access: { clinical: false, billing: false } };

const BILLER = testSession({
  staff: { id: 5, role: 'biller', is_clinician: false },
  capabilities: ['view_all_clients', 'billing_all', 'view_reports'],
});
const SCHEDULER = testSession({
  staff: { id: 6, role: 'scheduler', is_clinician: false },
  capabilities: ['view_all_clients', 'schedule_all'],
});
const OTHER_CLINICIAN = testSession({
  staff: { id: 8, role: 'clinician', clinician_access: 'client_list' },
  capabilities: ['view_all_clients', 'billing_own'],
});

const base: ClientFormSummary = {
  id: 1,
  client_id: 9,
  template_id: 1,
  kind: 'intake',
  name: 'Intake Questionnaire',
  status: 'pending',
  requires_signature: false,
  sent_at: '2026-09-20T14:00:00Z',
  viewed_at: null,
  completed_at: null,
  last_reminded_at: null,
  reminder_count: 0,
  score: null,
  score_label: '',
  flagged: false,
};

const PHQ: ClientFormSummary = {
  ...base,
  id: 3,
  template_id: 3,
  kind: 'assessment',
  name: 'PHQ-9',
  status: 'completed',
  viewed_at: '2026-09-21T14:00:00Z',
  completed_at: '2026-09-21T14:10:00Z',
  score: 14,
  score_label: 'Moderate',
  flagged: true,
};

const CONSENT: ClientFormSummary = {
  ...base,
  id: 2,
  template_id: 2,
  kind: 'consent',
  name: 'Informed Consent',
  requires_signature: true,
  viewed_at: '2026-09-21T13:00:00Z',
};

/** PHQ-9 as the API returns it to staff without clinical access: results withheld. */
const PHQ_HIDDEN: ClientFormSummary = { ...PHQ, score: null, score_label: null, flagged: null };

const PHQ_DETAIL: ClientFormDetail = {
  ...PHQ,
  score_label: 'Moderate',
  flagged: true,
  description: '',
  fields: [
    {
      id: 'q9',
      type: 'single_choice',
      label: 'Thoughts that you would be better off dead',
      required: true,
      options: [
        { label: 'Not at all', value: 0 },
        { label: 'Several days', value: 1 },
      ],
    },
  ],
  scoring: { method: 'sum', items: ['q9'], max_score: 27, bands: [], flags: [] },
  answers: { q9: 1 },
  flag_reason: 'Item 9 (thoughts of self-harm) endorsed',
  signature_name: '',
  signed_at: null,
  signer_ip: '',
  signer_user_agent: '',
  signature_sha256: '',
  signature_integrity: null,
};

const template = (id: number, kind: TemplateSummary['kind'], name: string): TemplateSummary => ({
  id,
  kind,
  name,
  description: '',
  requires_signature: kind === 'consent',
  library_key: null,
  read_only: false,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
});

const TEMPLATES = [
  template(1, 'intake', 'Intake Questionnaire'),
  template(2, 'consent', 'Informed Consent'),
  template(3, 'assessment', 'PHQ-9'),
];

function renderTab(session: Session = testSession()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <ClientDocumentsTab clientId={9} />
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

async function rowFor(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name)).closest('li') as HTMLElement;
}

describe('ClientDocumentsTab', () => {
  beforeEach(() => {
    vi.mocked(clientsApi.get).mockResolvedValue(CLIENT);
    vi.mocked(filesApi.forClient).mockResolvedValue([]);
    forms.templates.mockResolvedValue(TEMPLATES);
    forms.clientForms.mockResolvedValue([PHQ, CONSENT, base]);
    forms.clientForm.mockResolvedValue(PHQ_DETAIL);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists forms with their status, score and review flag', async () => {
    renderTab();
    const phq = (await screen.findByText('PHQ-9')).closest('li') as HTMLElement;
    expect(within(phq).getByText('Completed')).toBeInTheDocument();
    expect(within(phq).getByText('Needs review')).toBeInTheDocument();
    expect(within(phq).getByText('Score 14')).toBeInTheDocument();
    expect(within(phq).getByText(/Moderate/)).toBeInTheDocument();
    const consent = screen.getByText('Informed Consent').closest('li') as HTMLElement;
    expect(within(consent).getByText('Viewed')).toBeInTheDocument();
    expect(within(consent).getByRole('button', { name: 'Send a reminder about Informed Consent' })).toBeInTheDocument();
    const intake = screen.getByText('Intake Questionnaire').closest('li') as HTMLElement;
    expect(within(intake).getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/1 needs review/)).toBeInTheDocument();
  });

  it('shows a completed form read-only with answers, score and flag reason', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'View PHQ-9' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Item 9 (thoughts of self-harm) endorsed')).toBeInTheDocument();
    expect(within(dialog).getByText('Several days (1)')).toBeInTheDocument();
    expect(within(dialog).getByText('/ 27')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
  });

  it('preselects intake and consent templates for a client who has no forms yet', async () => {
    const user = userEvent.setup();
    forms.clientForms.mockResolvedValue([]);
    forms.share.mockResolvedValue([base, CONSENT]);
    renderTab();

    await user.click((await screen.findAllByRole('button', { name: 'Share forms' }))[0]);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('checkbox', { name: /Intake Questionnaire/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Informed Consent/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /PHQ-9/ })).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Send 2 forms' }));
    await waitFor(() => expect(forms.share).toHaveBeenCalledWith(9, [1, 2]));
  });

  it('explains why forms cannot be sent when the server refuses', async () => {
    const user = userEvent.setup();
    forms.share.mockRejectedValue(new ApiError(409, "This client doesn't have portal access, so forms can't be sent"));
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Share forms' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('checkbox', { name: /PHQ-9/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Send 1 form' }));
    expect(await within(dialog).findByText("This client doesn't have portal access, so forms can't be sent")).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open client details' })).toHaveAttribute('href', '/portal/clients/9');
  });

  it('blocks sharing up front when the client has no email address', async () => {
    const user = userEvent.setup();
    vi.mocked(clientsApi.get).mockResolvedValue({ ...CLIENT, email: null });
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Share forms' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Add an email address for Alex/)).toBeInTheDocument();
    await user.click(await within(dialog).findByRole('checkbox', { name: /PHQ-9/ }));
    expect(within(dialog).getByRole('button', { name: 'Send 1 form' })).toBeDisabled();
  });

  it('keeps results, answers and files from staff without clinical access', async () => {
    vi.mocked(clientsApi.get).mockResolvedValue(PROFILE_ONLY_CLIENT);
    forms.clientForms.mockResolvedValue([PHQ_HIDDEN, CONSENT, base]);
    renderTab(BILLER);

    const phq = await rowFor('PHQ-9');
    expect(within(phq).getByText('Completed')).toBeInTheDocument();
    expect(within(phq).getByText('Results visible to the care team')).toBeInTheDocument();
    expect(within(phq).queryByText(/Score/)).not.toBeInTheDocument();
    expect(within(phq).queryByText('Needs review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^View / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /as PDF$/ })).not.toBeInTheDocument();
    expect(screen.getByText('2 waiting on the client')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share forms' })).toBeInTheDocument();

    expect(screen.getByText(/part of their clinical record/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share a document' })).not.toBeInTheDocument();
    expect(filesApi.forClient).not.toHaveBeenCalled();
  });

  it.each([
    ['the client’s clinician', true, testSession(), CLIENT],
    ['a scheduler', true, SCHEDULER, PROFILE_ONLY_CLIENT],
    ['a biller', false, BILLER, PROFILE_ONLY_CLIENT],
    ['a clinician outside the care team', false, OTHER_CLINICIAN, PROFILE_ONLY_CLIENT],
  ])('%s can remind and withdraw pending forms: %s', async (_who, allowed, session, client) => {
    vi.mocked(clientsApi.get).mockResolvedValue(client);
    renderTab(session);

    const consent = await rowFor('Informed Consent');
    const remind = within(consent).queryByRole('button', { name: 'Send a reminder about Informed Consent' });
    const withdraw = within(consent).queryByRole('button', { name: 'Withdraw Informed Consent' });
    if (allowed) {
      expect(remind).toBeInTheDocument();
      expect(withdraw).toBeInTheDocument();
    } else {
      expect(remind).not.toBeInTheDocument();
      expect(withdraw).not.toBeInTheDocument();
    }
  });
});
