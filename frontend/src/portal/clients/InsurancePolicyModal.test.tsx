import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { InsurancePolicy } from '../../api/clients';
import { InsurancePolicyModal } from './InsurancePolicyModal';

const mocks = vi.hoisted(() => ({ payers: vi.fn(), save: vi.fn() }));

vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, payers: mocks.payers } };
});

const PAYERS = [
  { id: 4, name: 'Aetna', external_id: '60054', claim_filing_indicator: 'CI' },
  { id: 5, name: 'Medicaid of Texas', external_id: '', claim_filing_indicator: 'MC' },
];

function renderModal(policy: InsurancePolicy | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <InsurancePolicyModal
        policy={policy}
        defaultRank="primary"
        saving={false}
        serverErrors={{}}
        formError={null}
        onClose={() => undefined}
        onSave={mocks.save}
      />
    </QueryClientProvider>,
  );
  return screen.getByRole('dialog');
}

describe('InsurancePolicyModal', () => {
  beforeEach(() => {
    mocks.payers.mockReset();
    mocks.save.mockReset();
    mocks.payers.mockResolvedValue(PAYERS);
  });

  it("asks for the subscriber's details only when the client isn't the subscriber", async () => {
    const user = userEvent.setup();
    const dialog = renderModal();
    const payer = within(dialog).getByRole('combobox', { name: /insurance payer/i });
    await within(payer).findByRole('option', { name: 'Aetna (60054)' });
    expect(within(dialog).queryByLabelText(/subscriber first name/i)).not.toBeInTheDocument();

    await user.selectOptions(within(dialog).getByRole('combobox', { name: /relationship to the subscriber/i }), '19');
    for (const label of [/subscriber first name/i, /subscriber last name/i, /subscriber date of birth/i, /subscriber sex/i, /subscriber address/i]) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    }
    await user.click(within(dialog).getByRole('button', { name: 'Add policy' }));
    expect(within(dialog).getByText('Choose the insurance payer')).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the subscriber's first name")).toBeInTheDocument();
    expect(within(dialog).getByText("Choose the subscriber's sex")).toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();

    await user.selectOptions(within(dialog).getByRole('combobox', { name: /relationship to the subscriber/i }), '18');
    expect(within(dialog).queryByLabelText(/subscriber first name/i)).not.toBeInTheDocument();
    await user.selectOptions(payer, '4');
    await user.type(within(dialog).getByLabelText(/member id/i), 'W123');
    await user.type(within(dialog).getByLabelText(/copay/i), '30');
    await user.click(within(dialog).getByRole('button', { name: 'Add policy' }));

    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        payer_id: 4,
        rank: 'primary',
        member_id: 'W123',
        copay_cents: 3000,
        subscriber_relationship: '18',
        subscriber_first_name: '',
      }),
    );
  });

  it('saves a dependent policy with the subscriber filled in', async () => {
    const user = userEvent.setup();
    const dialog = renderModal();
    await within(dialog).findByRole('option', { name: 'Medicaid of Texas' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /insurance payer/i }), '5');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /relationship to the subscriber/i }), '19');
    await user.type(within(dialog).getByLabelText(/subscriber first name/i), 'Pat');
    await user.type(within(dialog).getByLabelText(/subscriber last name/i), 'Rivera');
    await user.type(within(dialog).getByLabelText(/subscriber date of birth/i), '1980-02-03');
    await user.selectOptions(within(dialog).getByLabelText(/subscriber sex/i), 'F');
    await user.type(within(dialog).getByLabelText(/subscriber address/i), '1 Main St');
    await user.type(within(dialog).getByLabelText(/^city/i), 'Austin');
    await user.type(within(dialog).getByLabelText(/^state/i), 'TX');
    await user.type(within(dialog).getByLabelText(/^zip/i), '78701');
    await user.click(within(dialog).getByRole('button', { name: 'Add policy' }));

    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        payer_id: 5,
        subscriber_relationship: '19',
        subscriber_first_name: 'Pat',
        subscriber_dob: '1980-02-03',
        subscriber_sex: 'F',
        subscriber_postal_code: '78701',
      }),
    );
  });

  it("keeps working when the practice's payers can't be loaded", async () => {
    mocks.payers.mockRejectedValue(new ApiError(404, 'Not Found'));
    const dialog = renderModal();
    expect(await within(dialog).findByText("Couldn't load your practice's payers")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('explains when the practice has no payers yet', async () => {
    mocks.payers.mockResolvedValue([]);
    const dialog = renderModal();
    expect(await within(dialog).findByText(/hasn't added any insurance payers yet/i)).toBeInTheDocument();
  });
});
