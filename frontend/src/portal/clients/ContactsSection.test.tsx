import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import type { ClientDetail } from '../../api/clients';
import { ROLE_SESSIONS, testClient, testContact } from '../../test/clients';
import { WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { ContactsSection } from './ContactsSection';

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), remove: vi.fn(), invite: vi.fn() }));

vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, contacts: mocks } };
});

const guardian = testContact({
  is_guardian: true,
  responsible_for_billing: true,
  portal_access: true,
  relation: 'Mother',
});
const grandpa = testContact({
  id: 32,
  first_name: 'Lou',
  last_name: 'Rivera',
  relation: 'Grandparent',
  email: null,
  phone: '555-0199',
  is_emergency_contact: true,
});
const minor = testClient({ is_minor: true, contacts: [guardian, grandpa] });

function renderSection(client: ClientDetail = minor, session: Session = ROLE_SESSIONS.owner) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <ContactsSection client={client} />
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('ContactsSection', () => {
  beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

  it('lists contacts with their roles and portal sign-in status', async () => {
    mocks.invite.mockResolvedValue({ detail: 'Invitation sent to pat@example.com' });
    const user = userEvent.setup();
    renderSection();

    const pat = screen.getByText('Pat Rivera').closest('li') as HTMLElement;
    for (const badge of ['Guardian', 'Billing contact', 'Portal access']) {
      expect(within(pat).getByText(badge)).toBeInTheDocument();
    }
    expect(within(pat).getByText("Hasn't signed in to the portal yet")).toBeInTheDocument();
    const lou = screen.getByText('Lou Rivera').closest('li') as HTMLElement;
    expect(within(lou).getByText('Emergency contact')).toBeInTheDocument();
    expect(within(lou).queryByRole('button', { name: /portal invite/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/add a parent or legal guardian/i)).not.toBeInTheDocument();

    await user.click(within(pat).getByRole('button', { name: 'Send portal invite to Pat Rivera' }));
    await waitFor(() => expect(mocks.invite).toHaveBeenCalledWith(7, 31));
    expect(await screen.findByText('Invitation sent to pat@example.com')).toBeInTheDocument();
  });

  it('is read-only for roles that cannot change the profile', () => {
    renderSection({ ...minor, access: { clinical: false, billing: true } }, ROLE_SESSIONS.biller);
    expect(screen.getByText('Pat Rivera')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add contact/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit pat rivera/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /portal invite/i })).not.toBeInTheDocument();
  });

  it('asks for a guardian when a minor has none', () => {
    renderSection(testClient({ is_minor: true }));
    expect(screen.getByText('This client is a minor. Add a parent or legal guardian.')).toBeInTheDocument();
    expect(screen.getByText('No contacts yet')).toBeInTheDocument();
  });

  it('validates a new contact before saving it', async () => {
    mocks.create.mockResolvedValue(testContact({ id: 40, first_name: 'Jamie', last_name: 'Cole' }));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /add contact/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /portal access/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Add contact' }));
    expect(within(dialog).getByText('Enter a first name')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter an email address to give this contact portal access')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/first name/i), 'Jamie');
    await user.type(within(dialog).getByLabelText(/last name/i), 'Cole');
    await user.type(within(dialog).getByLabelText(/^email/i), 'Jamie@Example.com');
    await user.click(within(dialog).getByRole('checkbox', { name: /parent or legal guardian/i }));
    await user.click(within(dialog).getByRole('checkbox', { name: /responsible for billing/i }));
    expect(within(dialog).getByText('Replaces Pat Rivera as the billing contact.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add contact' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(7, {
        first_name: 'Jamie',
        last_name: 'Cole',
        relation: '',
        email: 'jamie@example.com',
        phone: '',
        is_guardian: true,
        is_emergency_contact: false,
        responsible_for_billing: true,
        portal_access: true,
      }),
    );
    expect(await screen.findByText('Jamie Cole was added')).toBeInTheDocument();
  });

  it("shows the server's duplicate-email error on the email field", async () => {
    mocks.update.mockRejectedValue(new ApiError(409, 'Another contact of this client already uses this email'));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Edit Lou Rivera' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^email/i), 'pat@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save contact' }));

    expect(await within(dialog).findByText('Another contact of this client already uses this email')).toBeInTheDocument();
    expect(mocks.update).toHaveBeenCalledWith(7, 32, expect.objectContaining({ email: 'pat@example.com', first_name: 'Lou' }));
  });

  it('removes a contact after confirming', async () => {
    mocks.remove.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Remove Pat Rivera' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/they will be signed out of the portal/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove contact' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(7, 31));
  });
});
