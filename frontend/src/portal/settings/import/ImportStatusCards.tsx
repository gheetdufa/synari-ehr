import { CalendarDays, CheckCircle2, Receipt, Users } from 'lucide-react';
import type { ImportJob, ImportResult, ImportWarning } from '../../../api/imports';
import { LinkButton } from '../../../ui/Button';
import { Card, CardBody, CardHeader } from '../../../ui/Card';
import { Alert, Badge, Table, Td, Th } from '../../../ui/Display';
import { Spinner } from '../../../ui/Spinner';
import { phaseLabel, progressPercent, resultRows } from './importLogic';
import { ProgressBar } from './ProgressBar';

export function WarningList({ warnings }: { warnings: ImportWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Warnings" />
      <ul className="divide-y divide-sage-100">
        {warnings.map((warning) => (
          <li key={`${warning.code}-${warning.message}`} className="flex items-start justify-between gap-3 px-5 py-3 text-sm">
            <span className="text-sage-800">{warning.message}</span>
            {warning.count > 1 && <Badge tone="warning">{warning.count.toLocaleString('en-US')}</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Created, updated and skipped counts per kind of record. */
export function ResultTable({ result }: { result: ImportResult }) {
  const rows = resultRows(result);
  if (rows.length === 0) return <p className="px-5 py-4 text-sm text-sage-600">Nothing was imported.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Records</Th>
          <Th className="text-right">Added</Th>
          <Th className="text-right">Updated</Th>
          <Th className="text-right">Skipped</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-sage-100">
        {rows.map((row) => (
          <tr key={row.key}>
            <Td>{row.label}</Td>
            <Td className="text-right">{row.created.toLocaleString('en-US')}</Td>
            <Td className="text-right">{row.updated.toLocaleString('en-US')}</Td>
            <Td className="text-right">{row.skipped.toLocaleString('en-US')}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** The worker is reading the files. */
export function AnalyzingCard() {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
        <Spinner className="h-8 w-8 text-primary-600" />
        <p className="font-medium text-sage-900">Analyzing your files…</p>
        <p className="max-w-md text-sm text-sage-600">
          Large exports can take a few minutes. You can leave this page; the analysis continues and this page updates
          when it's done.
        </p>
      </CardBody>
    </Card>
  );
}

/** Live progress while importing. */
export function ImportProgress({ job }: { job: ImportJob }) {
  const result = job.result;
  const percent = result ? progressPercent(result.processed, result.total) : 0;
  const phase = phaseLabel(result?.phase ?? '');
  return (
    <Card>
      <CardHeader
        title="Importing"
        description="You can leave this page; the import keeps running and you'll get a notification when it finishes."
      />
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-medium text-sage-800">{phase}</span>
          <span className="text-sage-600">{percent}%</span>
        </div>
        <ProgressBar label="Import progress" percent={percent} />
        {result && result.total > 0 && (
          <p className="text-sm text-sage-600">
            {result.processed.toLocaleString('en-US')} of {result.total.toLocaleString('en-US')} records processed
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** The finished import: what was added, updated and skipped, and where to look next. */
export function ImportSummary({ job }: { job: ImportJob }) {
  const result = job.result;
  return (
    <div className="space-y-6">
      <Alert tone="success" title="Import complete">
        Your SimplePractice records are in Synari. The uploaded files have been deleted; this summary is kept.
      </Alert>
      <Card>
        <CardHeader title="Results" />
        {result ? <ResultTable result={result} /> : <p className="px-5 py-4 text-sm text-sage-600">No summary is available.</p>}
        <CardBody className="flex flex-wrap gap-2 border-t border-sage-100">
          <LinkButton to="/portal/clients" variant="secondary" size="sm" icon={<Users className="h-4 w-4" />}>
            View clients
          </LinkButton>
          <LinkButton to="/portal/calendar" variant="secondary" size="sm" icon={<CalendarDays className="h-4 w-4" />}>
            Open the calendar
          </LinkButton>
          <LinkButton to="/portal/billing" variant="secondary" size="sm" icon={<Receipt className="h-4 w-4" />}>
            Review balances
          </LinkButton>
        </CardBody>
      </Card>
      {result && <WarningList warnings={result.warnings} />}
      <Card>
        <CardHeader title="Next steps" />
        <CardBody>
          <ul className="space-y-2 text-sm text-sage-700">
            {[
              'Recreate upcoming appointments (SimplePractice exports only include past sessions).',
              'Check imported clients’ insurance and diagnoses before billing.',
              'Invite clients to the Synari portal when you’re ready.',
            ].map((step) => (
              <li key={step} className="flex gap-2">
                <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" />
                {step}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
