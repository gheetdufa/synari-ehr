import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Payer } from '../../api/insurance';
import { testSession } from '../../test/session';
import { READ_ONLY_NOTE } from '../settings/SettingsForm';
import { settingsTabsFor } from '../settings/settingsTabs';
import { BillingSubNav } from './BillingSubNav';
import { BILLER, CLINICIAN_BILLING_OWN, renderInsurance, settingsFixture } from './insurance.fixture';
import RemittancesPage from './remittances/RemittancesPage';
import { InsuranceSettings } from './settings/InsuranceSettings';

const insurance = vi.hoisted(() => ({ settings: vi.fn(), payers: vi.fn() }));
const remittances = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../api/insurance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/insurance')>();
  return { ...actual, insuranceApi: { ...actual.insuranceApi, ...insurance } };
});
vi.mock('../../api/remittances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/remittances')>();
  return { ...actual, remittancesApi: { ...actual.remittancesApi, ...remittances } };
});

const PAYER: Payer = {
  id: 2,
  name: 'Evergreen Health Plan',
  external_id: 'EVRGN',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  claim_filing_indicator: 'CI',
  era_enrolled: true,
  notes: '',
  is_active: true,
};

const SCHEDULER = testSession({
  staff: { role: 'scheduler', is_clinician: false },
  capabilities: ['view_all_clients', 'schedule_all'],
});

describe('insurance access by role', () => {
  beforeEach(() => {
    insurance.settings.mockReset().mockResolvedValue(settingsFixture({ clearinghouse_enabled: false }));
    insurance.payers.mockReset().mockResolvedValue([PAYER]);
    remittances.list.mockReset().mockResolvedValue([]);
  });

  it('shows the Insurance settings tab to people who handle billing', () => {
    expect(settingsTabsFor(testSession())).toContain('insurance');
    expect(settingsTabsFor(BILLER)).toContain('insurance');
    expect(settingsTabsFor(CLINICIAN_BILLING_OWN)).toContain('insurance');
    expect(settingsTabsFor(SCHEDULER)).not.toContain('insurance');
  });

  it('links insurance payments only for practice-wide billing', () => {
    renderInsurance(<BillingSubNav />, { session: BILLER });
    expect(screen.getByRole('link', { name: 'Claims' })).toHaveAttribute('href', '/portal/billing/claims');
    expect(screen.getByRole('link', { name: 'Insurance payments' })).toHaveAttribute('href', '/portal/billing/remittances');
  });

  it('hides insurance payments from clinicians who bill their own clients', async () => {
    renderInsurance(<BillingSubNav />, { session: CLINICIAN_BILLING_OWN });
    expect(screen.getByRole('link', { name: 'Claims' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Insurance payments' })).not.toBeInTheDocument();
  });

  it("doesn't load insurance payments for a clinician who bills their own clients", () => {
    renderInsurance(<RemittancesPage />, { session: CLINICIAN_BILLING_OWN });
    expect(screen.getByText('Not available for your role')).toBeInTheDocument();
    expect(remittances.list).not.toHaveBeenCalled();
  });

  it('lets billers manage payers but not change claim options', async () => {
    renderInsurance(<InsuranceSettings />, { session: BILLER });
    expect(await screen.findByText('Evergreen Health Plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add payer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Evergreen Health Plan' })).toBeInTheDocument();
    expect(screen.getByText(READ_ONLY_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Submitter ID')).toBeDisabled();
  });

  it('shows clinicians who bill their own clients the setup read-only', async () => {
    renderInsurance(<InsuranceSettings />, { session: CLINICIAN_BILLING_OWN });
    expect(await screen.findByText('Evergreen Health Plan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add payer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Evergreen Health Plan' })).not.toBeInTheDocument();
    expect(screen.getByText(READ_ONLY_NOTE)).toBeInTheDocument();
  });

  it('explains how to connect a clearinghouse and lets owners save claim options', async () => {
    renderInsurance(<InsuranceSettings />);
    expect(await screen.findByText('No clearinghouse connected')).toBeInTheDocument();
    expect(screen.getByText('STEDI_API_KEY')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Check eligibility automatically/ })).toBeDisabled();
  });
});
