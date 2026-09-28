import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { portalFormsApi, type PortalForm, type PortalFormSummary } from '../../api/forms';
import ClientFormPage from './ClientFormPage';
import { draftStorageKey } from './formDraftStorage';

vi.mock('../../auth/ClientAuth', () => ({
  usePortalClient: () => ({
    id: 7,
    first_name: 'Alex',
    last_name: 'Rivera',
    preferred_name: '',
    email: 'alex@example.com',
    clinician_name: 'Dr. Sam Lee',
    practice_name: 'Calm Practice',
    time_zone: 'America/New_York',
    permissions: { messaging: true, booking: true, billing: true },
  }),
}));

vi.mock('../../api/forms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/forms')>();
  return { ...actual, portalFormsApi: { list: vi.fn(), get: vi.fn(), submit: vi.fn() } };
});

const api = vi.mocked(portalFormsApi);

const CONSENT: PortalForm = {
  id: 5,
  kind: 'consent',
  name: 'Telehealth Consent',
  status: 'pending',
  requires_signature: true,
  sent_at: '2026-09-20T12:00:00Z',
  completed_at: null,
  fields: [
    { id: 'intro', type: 'paragraph', label: 'Please read this carefully.' },
    { id: 'location', type: 'short_text', label: 'Where will you usually join from?', required: true },
    { id: 'ok_to_call', type: 'yes_no', label: 'May we call you if the video drops?', required: true },
  ],
  answers: null,
  signature_name: '',
  signed_at: null,
};

const NEXT: PortalFormSummary = {
  id: 6,
  kind: 'assessment',
  name: 'PHQ-9',
  status: 'pending',
  requires_signature: false,
  sent_at: '2026-09-20T12:00:00Z',
  completed_at: null,
};

function renderPage(formId = 5) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[`/client/documents/forms/${formId}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/client/documents/forms/:formId" element={<ClientFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientFormPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    api.get.mockResolvedValue(CONSENT);
    api.list.mockResolvedValue([{ ...CONSENT }, NEXT]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('checks required answers and the signature before submitting', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Sign and submit' }));

    expect(api.submit).not.toHaveBeenCalled();
    expect(screen.getByText(/3 answers need attention/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Where will you usually join from/ })).toHaveAccessibleDescription(
      'This question is required',
    );
    expect(screen.getByText('Type your full name to sign')).toBeInTheDocument();
  });

  it('submits normalized answers with the signature and shows the next form', async () => {
    const user = userEvent.setup();
    api.submit.mockResolvedValue({ ...CONSENT, status: 'completed', completed_at: '2026-09-25T12:00:00Z' });
    renderPage();

    await user.type(await screen.findByRole('textbox', { name: /Where will you usually join from/ }), '  Home office ');
    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    await user.type(screen.getByRole('textbox', { name: /Type your full name/ }), 'Alex Rivera');
    await user.click(screen.getByRole('checkbox', { name: /I agree to sign this form electronically/ }));
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));

    await waitFor(() =>
      expect(api.submit).toHaveBeenCalledWith(5, {
        answers: { location: 'Home office', ok_to_call: true },
        signature_name: 'Alex Rivera',
        signature_agreed: true,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Next: PHQ-9' })).toHaveAttribute('href', '/client/documents/forms/6');
    expect(sessionStorage.getItem(draftStorageKey(7, 5))).toBeNull();
  });

  it('shows the errors the server returns next to each answer and keeps the answers', async () => {
    const user = userEvent.setup();
    api.submit.mockRejectedValue(
      new ApiError(422, {
        message: 'Some answers need attention',
        errors: { location: 'Keep this to 5000 characters or fewer' },
        signature: null,
      }),
    );
    renderPage();

    const location = await screen.findByRole('textbox', { name: /Where will you usually join from/ });
    await user.type(location, 'Home');
    await user.click(screen.getByRole('radio', { name: 'No' }));
    await user.type(screen.getByRole('textbox', { name: /Type your full name/ }), 'Alex Rivera');
    await user.click(screen.getByRole('checkbox', { name: /I agree/ }));
    await user.click(screen.getByRole('button', { name: 'Sign and submit' }));

    await waitFor(() => expect(location).toHaveAccessibleDescription('Keep this to 5000 characters or fewer'));
    expect(location).toHaveValue('Home');
    await waitFor(() => expect(location).toHaveFocus());
  });

  it('restores in-progress answers from this browser tab and saves new ones', async () => {
    const user = userEvent.setup();
    const key = draftStorageKey(7, 5);
    sessionStorage.setItem(key, JSON.stringify({ answers: { location: 'Kitchen' }, signatureName: 'Alex' }));
    renderPage();

    const location = await screen.findByRole('textbox', { name: /Where will you usually join from/ });
    expect(location).toHaveValue('Kitchen');
    expect(screen.getByRole('textbox', { name: /Type your full name/ })).toHaveValue('Alex');
    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    expect(JSON.parse(sessionStorage.getItem(key) ?? '{}').answers).toEqual({ location: 'Kitchen', ok_to_call: true });
  });

  it('shows a completed form read-only with its signature', async () => {
    api.get.mockResolvedValue({
      ...CONSENT,
      status: 'completed',
      completed_at: '2026-09-21T15:00:00Z',
      answers: { location: 'Home office', ok_to_call: false },
      signature_name: 'Alex Rivera',
      signed_at: '2026-09-21T15:00:00Z',
    });
    renderPage();

    expect(await screen.findByText('Home office')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
    expect(screen.getByText('Electronically signed')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('explains when a form is no longer available', async () => {
    api.get.mockRejectedValue(new ApiError(404, 'Form not found'));
    renderPage();
    expect(await screen.findByText("This form isn't available")).toBeInTheDocument();
    expect(screen.getByText(/withdrawn by Dr\. Sam Lee/)).toBeInTheDocument();
  });
});
