import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { renderInsurance } from '../insurance.fixture';
import { PayerModal } from './PayerModal';

const insurance = vi.hoisted(() => ({ searchPayers: vi.fn(), createPayer: vi.fn() }));

vi.mock('../../../api/insurance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/insurance')>();
  return { ...actual, insuranceApi: { ...actual.insuranceApi, ...insurance } };
});

describe('adding a payer', () => {
  beforeEach(() => {
    insurance.searchPayers.mockReset().mockResolvedValue([
      {
        stedi_id: 'HPQRS',
        name: 'Evergreen Health Plan',
        payer_id: 'EVRGN',
        aliases: ['Evergreen'],
        professional_claims: 'SUPPORTED',
        eligibility: 'SUPPORTED',
        remittances: 'ENROLLMENT_REQUIRED',
      },
    ]);
    insurance.createPayer.mockReset().mockImplementation((input) => Promise.resolve({ id: 9, ...input }));
  });

  it('finds the payer in the clearinghouse network and fills its name and ID', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderInsurance(<PayerModal payer={null} clearinghouseEnabled onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Find payer' }));
    await user.type(screen.getByLabelText('Payer name or ID'), 'everg{Enter}');
    await waitFor(() => expect(insurance.searchPayers).toHaveBeenCalledWith('everg'));
    expect(await screen.findByText('ERA: Enrollment required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use Evergreen Health Plan' }));

    expect(screen.getByLabelText(/^Name/)).toHaveValue('Evergreen Health Plan');
    expect(screen.getByLabelText('Payer ID')).toHaveValue('EVRGN');
    await user.click(screen.getByRole('button', { name: 'Add payer' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(insurance.createPayer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Evergreen Health Plan', external_id: 'EVRGN', claim_filing_indicator: 'CI', is_active: true }),
    );
  });

  it('explains when the clearinghouse search fails', async () => {
    const user = userEvent.setup();
    insurance.searchPayers.mockRejectedValue(new ApiError(502, 'The clearinghouse is unavailable.'));
    renderInsurance(<PayerModal payer={null} clearinghouseEnabled onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Find payer' }));
    await user.type(screen.getByLabelText('Payer name or ID'), 'aetna');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('The clearinghouse is unavailable.')).toBeInTheDocument();
  });

  it('has no search without a clearinghouse, and needs a name', async () => {
    const user = userEvent.setup();
    renderInsurance(<PayerModal payer={null} clearinghouseEnabled={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Find payer' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add payer' }));
    expect(screen.getByText('Enter the insurance company’s name')).toBeInTheDocument();
    expect(insurance.createPayer).not.toHaveBeenCalled();
  });
});
