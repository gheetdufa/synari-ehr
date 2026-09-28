import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientsApi, type ClientRef, type ClientSummary } from '../../api/clients';
import { page } from '../../test/page';
import { ClientPicker } from './ClientSearch';

const alex: ClientSummary = {
  id: 7,
  first_name: 'Alex',
  last_name: 'Rivera',
  preferred_name: '',
  status: 'active',
  email: 'alex@example.com',
  phone: '555-0100',
  date_of_birth: null,
  created_at: '2026-01-01T00:00:00Z',
  care_team: [],
};

function Picker({ onChange }: { onChange: (client: ClientRef | null) => void }) {
  const [value, setValue] = useState<ClientRef | null>(null);
  return (
    <ClientPicker
      access="billing"
      value={value}
      placeholder="Search clients…"
      onChange={(client) => {
        setValue(client);
        onChange(client);
      }}
    />
  );
}

function renderPicker() {
  const onChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Picker onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe('ClientPicker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(clientsApi, 'list').mockResolvedValue(page([alex]));
  });

  it('searches one small page of clients on the server at the requested access level', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.type(screen.getByRole('combobox'), '555 0100');
    await user.click(await screen.findByRole('option', { name: /Alex Rivera/ }));

    expect(clientsApi.list).toHaveBeenLastCalledWith({ q: '555 0100', access: 'billing', limit: 8 });
    expect(onChange).toHaveBeenCalledWith({ id: 7, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' });
    expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
  });

  it('clears the choice and searches again', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Alex Rivera/ }));

    await user.click(screen.getByRole('button', { name: 'Clear client' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
  });

  it('says when nobody matches', async () => {
    vi.mocked(clientsApi.list).mockResolvedValue(page([]));
    const user = userEvent.setup();
    renderPicker();
    await user.type(screen.getByRole('combobox'), 'zz');
    expect(await screen.findByText('No clients match “zz”')).toBeInTheDocument();
  });
});
