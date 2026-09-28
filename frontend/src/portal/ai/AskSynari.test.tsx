import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from '../../api/ai';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import { testSession, WithSession } from '../../test/session';
import { AskSynari } from './AskSynari';

const config = vi.hoisted(() => ({ ai_enabled: true }));

vi.mock('../../lib/usePublicConfig', () => ({ usePublicConfig: () => config }));

vi.mock('../../api/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/ai')>();
  return { ...actual, aiApi: { generateNote: vi.fn(), assistant: vi.fn(), transcribe: vi.fn() } };
});

function renderAssistant(path = '/portal', session: Session = testSession()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AskSynari />
        </MemoryRouter>
      </WithSession>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  config.ai_enabled = true;
  vi.mocked(aiApi.assistant).mockReset();
});

describe('AskSynari', () => {
  it('renders nothing when AI is not configured', () => {
    config.ai_enabled = false;
    const { container } = renderAssistant();
    expect(container).toBeEmptyDOMElement();
  });

  it('offers client context only to staff who see clinical records', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAssistant();
    await user.click(screen.getByRole('button', { name: 'Ask Synari' }));
    expect(screen.getByRole('combobox', { name: 'About client (optional)' })).toBeInTheDocument();
    unmount();

    renderAssistant('/portal', testSession({ staff: { role: 'scheduler', is_clinician: false }, capabilities: ['schedule_all'] }));
    await user.click(screen.getByRole('button', { name: 'Ask Synari' }));
    expect(screen.getByRole('textbox', { name: 'Message Synari' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'About client (optional)' })).not.toBeInTheDocument();
  });

  it('hides the launcher on full-height pages', () => {
    renderAssistant('/portal/messaging');
    expect(screen.queryByRole('button', { name: 'Ask Synari' })).not.toBeInTheDocument();
  });

  it('sends the conversation with Enter and renders the reply as text and lists', async () => {
    vi.mocked(aiApi.assistant).mockResolvedValue({ reply: 'Try these:\n- **Specific** goals\n- Measurable steps' });
    const user = userEvent.setup();
    renderAssistant();

    await user.click(screen.getByRole('button', { name: 'Ask Synari' }));
    expect(screen.getByText('Synari can make mistakes. Clinical decisions are yours.', { exact: false })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message Synari' }), 'Help with goals{Enter}');

    expect(aiApi.assistant).toHaveBeenCalledWith(
      { messages: [{ role: 'user', content: 'Help with goals' }], client_id: null },
      expect.any(AbortSignal),
    );
    expect(await screen.findByText('Specific')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('textbox', { name: 'Message Synari' })).toHaveValue('');
  });

  it('explains provider failures and retries the same question', async () => {
    vi.mocked(aiApi.assistant)
      .mockRejectedValueOnce(new ApiError(502, "The AI service couldn't complete the request. Try again shortly."))
      .mockResolvedValueOnce({ reply: 'Here you go.' });
    const user = userEvent.setup();
    renderAssistant();

    await user.click(screen.getByRole('button', { name: 'Ask Synari' }));
    await user.type(screen.getByRole('textbox', { name: 'Message Synari' }), 'Question{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent("The AI service couldn't complete the request.");

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Here you go.')).toBeInTheDocument();
    expect(aiApi.assistant).toHaveBeenCalledTimes(2);
  });
});
