import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import { todayInZone } from '../../api/billing';
import { reportsApi, type ReportId, type ReportPeriod } from '../../api/reports';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatPlainDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { PageHeader, Tabs, type TabItem } from '../../ui/Display';
import { Field, Input, Select } from '../../ui/Form';
import { useToast } from '../../ui/Toast';
import { AgingReportView } from './AgingReportView';
import { ClaimsReportView } from './ClaimsReportView';
import { IncomeReportView } from './IncomeReportView';
import { PERIOD_PRESETS, periodError, presetPeriod, type PeriodPreset } from './periods';
import { SessionsReportView } from './SessionsReportView';

const REPORTS: { id: ReportId; label: string; description: string }[] = [
  {
    id: 'income',
    label: 'Income',
    description: 'Payments received in the period, credited to the clinician who provided each service.',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    description: 'Sessions held and client attendance by clinician, with the fees for attended sessions.',
  },
  {
    id: 'aging',
    label: 'Aging',
    description: 'What clients and insurers still owe, by how long each balance has been outstanding.',
  },
  { id: 'claims', label: 'Claims', description: 'Insurance claims created in the period, by payer and status.' },
];

const TABS: TabItem<ReportId>[] = REPORTS.map(({ id, label }) => ({ id, label }));

function parseTab(value: string | null): ReportId {
  return REPORTS.find((report) => report.id === value)?.id ?? 'income';
}

function DownloadCsvButton({ label, download }: { label: string; download: (() => Promise<void>) | null }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const onClick = async () => {
    if (!download) return;
    setLoading(true);
    try {
      await download();
    } catch (error) {
      toast.error(error);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button
      variant="secondary"
      icon={<Download className="h-4 w-4" />}
      loading={loading}
      disabled={download === null}
      onClick={onClick}
      aria-label={`Download the ${label.toLowerCase()} report as CSV`}
    >
      Download CSV
    </Button>
  );
}

/** /portal/reports — income, sessions, receivables aging and claims, practice-wide or for your clients. */
export default function ReportsPage() {
  const { practice } = useSession();
  const seesPractice = useCan('view_reports');
  const today = todayInZone(practice.time_zone);
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const report = REPORTS.find((entry) => entry.id === tab) ?? REPORTS[0];

  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [custom, setCustom] = useState<ReportPeriod>(() => presetPeriod('this_month', today));
  const [asOf, setAsOf] = useState(today);

  const period = preset === 'custom' ? custom : presetPeriod(preset, today);
  const error = periodError(period);
  const validPeriod = error === null ? period : null;
  const validAsOf = asOf || null;

  const selectTab = (next: ReportId) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.set('tab', next);
        return updated;
      },
      { replace: true },
    );

  const choosePreset = (next: PeriodPreset) => {
    if (next === 'custom') setCustom(period);
    setPreset(next);
  };

  const csvDownload = (): (() => Promise<void>) | null => {
    if (tab === 'aging') return validAsOf ? () => reportsApi.downloadCsv('aging', { as_of: validAsOf }) : null;
    return validPeriod ? () => reportsApi.downloadCsv(tab, validPeriod) : null;
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        description={
          seesPractice
            ? 'Income, sessions and balances across the practice.'
            : 'Income, sessions and balances for your clients.'
        }
      />
      <Card>
        <div className="px-4 pt-2 sm:px-5">
          <Tabs tabs={TABS} active={tab} onChange={selectTab} />
        </div>
        <div role="tabpanel" aria-label={report.label}>
          <div className="flex flex-wrap items-end gap-3 border-b border-sage-100 px-4 py-3 sm:px-5">
            {tab === 'aging' ? (
              <Field label="As of" className="w-full sm:w-44" error={validAsOf ? null : 'Pick a date.'}>
                {(props) => (
                  <Input {...props} type="date" value={asOf} max={today} onChange={(event) => setAsOf(event.target.value)} />
                )}
              </Field>
            ) : (
              <>
                <Field
                  label="Period"
                  className="w-full sm:w-44"
                  hint={preset === 'custom' ? undefined : `${formatPlainDate(period.start)} – ${formatPlainDate(period.end)}`}
                >
                  {(props) => (
                    <Select {...props} value={preset} onChange={(event) => choosePreset(event.target.value as PeriodPreset)}>
                      {PERIOD_PRESETS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {preset === 'custom' && (
                  <>
                    <Field label="From" className="w-[calc(50%-0.375rem)] sm:w-44">
                      {(props) => (
                        <Input
                          {...props}
                          type="date"
                          value={custom.start}
                          onChange={(event) => setCustom((current) => ({ ...current, start: event.target.value }))}
                        />
                      )}
                    </Field>
                    <Field label="To" className="w-[calc(50%-0.375rem)] sm:w-44">
                      {(props) => (
                        <Input
                          {...props}
                          type="date"
                          value={custom.end}
                          onChange={(event) => setCustom((current) => ({ ...current, end: event.target.value }))}
                        />
                      )}
                    </Field>
                  </>
                )}
              </>
            )}
            <div className="sm:ml-auto">
              <DownloadCsvButton label={report.label} download={csvDownload()} />
            </div>
            {tab !== 'aging' && error && (
              <p role="alert" className="w-full text-sm text-red-600">
                {error}
              </p>
            )}
          </div>
          <p className="border-b border-sage-100 px-4 py-3 text-sm text-sage-600 sm:px-5">{report.description}</p>
          {tab === 'income' && validPeriod && <IncomeReportView period={validPeriod} />}
          {tab === 'sessions' && validPeriod && <SessionsReportView period={validPeriod} />}
          {tab === 'claims' && validPeriod && <ClaimsReportView period={validPeriod} />}
          {tab === 'aging' && validAsOf && <AgingReportView asOf={validAsOf} />}
        </div>
      </Card>
    </div>
  );
}
