import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '../../api/auth';
import { ApiError, downloadFile } from '../../api/client';
import { reportsApi, type AgingReport, type IncomeReport, type SessionRow } from '../../api/reports';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import ReportsPage from './ReportsPage';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, downloadFile: vi.fn() };
});

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };
const THIS_MONTH = { start: '2026-09-01', end: '2026-09-30' };

const INCOME: IncomeReport = {
  start: THIS_MONTH.start,
  end: THIS_MONTH.end,
  rows: [
    {
      clinician_id: 1,
      clinician_name: 'Dana Lee, LCSW',
      client_payments_cents: 30000,
      insurance_payments_cents: 12000,
      total_cents: 42000,
    },
    { clinician_id: null, clinician_name: 'Other', client_payments_cents: 2500, insurance_payments_cents: 0, total_cents: 2500 },
  ],
  unapplied_cents: 1000,
  total_cents: 45500,
};

const SESSIONS: SessionRow[] = [
  {
    clinician_id: 1,
    clinician_name: 'Dana Lee, LCSW',
    sessions: 10,
    attended: 12,
    no_show: 1,
    late_canceled: 1,
    canceled: 2,
    upcoming: 3,
    billed_cents: 180000,
  },
  {
    clinician_id: 2,
    clinician_name: 'Sam Ortiz, LPC',
    sessions: 4,
    attended: 4,
    no_show: 0,
    late_canceled: 0,
    canceled: 1,
    upcoming: 2,
    billed_cents: 60000,
  },
];

const AGING: AgingReport = {
  as_of: '2026-09-26',
  clients: [{ label: 'Alex Rivera', buckets: { '0-30': 15000, '31-60': 0, '61-90': 0, '90+': 5000 }, total_cents: 20000 }],
  insurance: [],
};

const CLINICIAN_WITH_BILLING: Session = testSession({
  staff: { role: 'clinician', clinician_access: 'billing' },
  capabilities: ['billing_own'],
});

function renderPage(session: Session = testSession(), path = '/portal/reports') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WithSession session={session}>
          <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
            <ReportsPage />
          </MemoryRouter>
        </WithSession>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T16:00:00Z'));
    vi.spyOn(reportsApi, 'income').mockResolvedValue(INCOME);
    vi.spyOn(reportsApi, 'sessions').mockResolvedValue(SESSIONS);
    vi.spyOn(reportsApi, 'aging').mockResolvedValue(AGING);
    vi.spyOn(reportsApi, 'claims').mockResolvedValue([]);
    vi.mocked(downloadFile).mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(downloadFile).mockReset();
  });

  it("shows this month's income by clinician with unapplied credit and totals", async () => {
    renderPage();

    expect(screen.getByText('Income, sessions and balances across the practice.')).toBeInTheDocument();
    const dana = (await screen.findByText('Dana Lee, LCSW')).closest('tr') as HTMLElement;
    expect(within(dana).getByText('$420.00')).toBeInTheDocument();
    expect(screen.getByText('Unapplied client credit')).toBeInTheDocument();
    const totals = screen.getByRole('cell', { name: 'Total' }).closest('tr') as HTMLElement;
    expect(within(totals).getByText('$335.00')).toBeInTheDocument();
    expect(within(totals).getByText('$120.00')).toBeInTheDocument();
    expect(within(totals).getByText('$455.00')).toBeInTheDocument();
    expect(reportsApi.income).toHaveBeenCalledWith(THIS_MONTH);
  });

  it('re-runs the report for last month', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Dana Lee, LCSW');

    await user.selectOptions(screen.getByLabelText('Period'), 'last_month');

    await waitFor(() => expect(reportsApi.income).toHaveBeenLastCalledWith({ start: '2026-08-01', end: '2026-08-31' }));
    expect(screen.getByText('Aug 1, 2026 – Aug 31, 2026')).toBeInTheDocument();
  });

  it('checks a custom period before running the report', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Dana Lee, LCSW');

    await user.selectOptions(screen.getByLabelText('Period'), 'custom');
    expect(screen.getByLabelText('From')).toHaveValue(THIS_MONTH.start);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-05' } });

    expect(screen.getByRole('alert')).toHaveTextContent('The end date is before the start date.');
    expect(screen.queryByText('Dana Lee, LCSW')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download the income report/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    await waitFor(() => expect(reportsApi.income).toHaveBeenLastCalledWith({ start: '2026-10-05', end: '2026-10-31' }));
  });

  it('downloads the report shown as CSV for the chosen period', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Dana Lee, LCSW');

    await user.click(screen.getByRole('button', { name: 'Download the income report as CSV' }));
    expect(downloadFile).toHaveBeenCalledWith('/reports/income?start=2026-09-01&end=2026-09-30&format=csv');

    await user.click(screen.getByRole('tab', { name: 'Aging' }));
    await user.click(screen.getByRole('button', { name: 'Download the aging report as CSV' }));
    expect(downloadFile).toHaveBeenLastCalledWith('/reports/aging?as_of=2026-09-26&format=csv');
  });

  it('shows sessions with column totals', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Sessions' }));

    const sam = (await screen.findByText('Sam Ortiz, LPC')).closest('tr') as HTMLElement;
    expect(within(sam).getByText('$600.00')).toBeInTheDocument();
    const totals = screen.getByRole('cell', { name: 'Total' }).closest('tr') as HTMLElement;
    expect(within(totals).getByText('14')).toBeInTheDocument();
    expect(within(totals).getByText('16')).toBeInTheDocument();
    expect(within(totals).getByText('$2,400.00')).toBeInTheDocument();
    expect(reportsApi.sessions).toHaveBeenCalledWith(THIS_MONTH);
  });

  it('opens the tab named in the URL and shows balances by age', async () => {
    renderPage(testSession(), '/portal/reports?tab=aging');

    expect(await screen.findByRole('heading', { name: 'Owed by clients' })).toBeInTheDocument();
    const alex = screen.getByText('Alex Rivera').closest('tr') as HTMLElement;
    expect(within(alex).getByText('$150.00')).toBeInTheDocument();
    expect(within(alex).getByText('$50.00')).toBeInTheDocument();
    expect(screen.getByText('No insurance claims are waiting on payment.')).toBeInTheDocument();
    expect(reportsApi.aging).toHaveBeenCalledWith('2026-09-26');
  });

  it('explains that claims appear once they exist', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Claims' }));

    expect(await screen.findByText('No claims in this period')).toBeInTheDocument();
    expect(reportsApi.claims).toHaveBeenCalledWith(THIS_MONTH);
  });

  it('tells a clinician with billing access the reports cover their clients', async () => {
    renderPage(CLINICIAN_WITH_BILLING);
    expect(screen.getByText('Income, sessions and balances for your clients.')).toBeInTheDocument();
    expect(await screen.findByText('Dana Lee, LCSW')).toBeInTheDocument();
  });

  it('shows a friendly message when the role has no reports', async () => {
    vi.mocked(reportsApi.income).mockRejectedValue(new ApiError(403, "Your role doesn't include reports"));
    renderPage();
    expect(await screen.findByText('Not available for your role')).toBeInTheDocument();
  });
});
