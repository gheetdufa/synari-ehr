import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Archive } from 'lucide-react';
import {
  MAX_RETENTION_YEARS,
  MIN_RETENTION_YEARS,
  practiceApi,
  practiceKeys,
  type PracticeSettings,
} from '../../api/practice';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatDateTime, formatPlainDate, fullName } from '../../lib/format';
import { Card, CardHeader } from '../../ui/Card';
import { EmptyState, ErrorState, Table, Td, Th } from '../../ui/Display';
import { Field, Input } from '../../ui/Form';
import { SectionSpinner } from '../../ui/Spinner';
import { SettingsForm, usePracticeSettingsForm } from './SettingsForm';

const KEYS = ['record_retention_years'] as const;

/** A problem with the retention period, or null. */
export function retentionProblem(years: number): string | null {
  if (!Number.isInteger(years) || years < MIN_RETENTION_YEARS || years > MAX_RETENTION_YEARS) {
    return `Choose a whole number of years from ${MIN_RETENTION_YEARS} to ${MAX_RETENTION_YEARS}`;
  }
  return null;
}

/** Archived clients whose retention period has passed. Nothing is deleted. */
function RetentionReport() {
  const { staff } = useSession();
  const report = useQuery({ queryKey: practiceKeys.retentionReport, queryFn: practiceApi.retentionReport });
  return (
    <Card>
      <CardHeader
        title="Records past retention"
        description="Archived clients whose records have been kept longer than your retention period. This list is for review only: Synari doesn't delete records."
      />
      {report.isPending && <SectionSpinner />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {report.data && report.data.length === 0 && (
        <EmptyState icon={<Archive />} title="Nothing past retention" description="No archived client has passed the retention period." />
      )}
      {report.data && report.data.length > 0 && (
        <Table>
          <caption className="sr-only">Archived clients past retention</caption>
          <thead className="bg-sage-50/60">
            <tr>
              <Th>Client</Th>
              <Th>Last activity</Th>
              <Th>Retention ended</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sage-100">
            {report.data.map((entry) => (
              <tr key={entry.client.id}>
                <Td>
                  <Link to={`/portal/clients/${entry.client.id}`} className="text-primary-700 hover:underline">
                    {fullName(entry.client)}
                  </Link>
                </Td>
                <Td className="text-sage-600">
                  {entry.last_activity_at ? formatDateTime(entry.last_activity_at, staff.time_zone) : 'None recorded'}
                </Td>
                <Td className="text-sage-600">{formatPlainDate(entry.retention_ends_on)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** How long client records are kept, and (for managers) which archived records are past it. */
export function RecordsSettings({ settings }: { settings: PracticeSettings }) {
  const canEdit = useCan('manage_practice');
  const form = usePracticeSettingsForm(settings, KEYS, 'Retention period saved');
  const { draft, set, errors } = form;
  const validate = (current: Pick<PracticeSettings, 'record_retention_years'>): Record<string, string> => {
    const problem = retentionProblem(current.record_retention_years);
    return problem ? { record_retention_years: problem } : {};
  };
  return (
    <div className="space-y-6">
      <SettingsForm
        title="Record retention"
        description="How long client records are kept after a client's last activity. State law may require longer, especially for minors."
        dirty={form.dirty}
        saving={form.saving}
        readOnly={!canEdit}
        onSubmit={() => form.submit(validate)}
        onDiscard={form.discard}
      >
        <Field
          label="Keep records for (years)"
          hint={`At least ${MIN_RETENTION_YEARS} years. Archived clients past this period are listed below for review.`}
          error={errors.record_retention_years}
          className="sm:max-w-xs"
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              inputMode="numeric"
              min={MIN_RETENTION_YEARS}
              max={MAX_RETENTION_YEARS}
              step={1}
              value={Number.isNaN(draft.record_retention_years) ? '' : draft.record_retention_years}
              onChange={(event) => set({ record_retention_years: event.target.valueAsNumber })}
            />
          )}
        </Field>
      </SettingsForm>
      {canEdit && <RetentionReport />}
    </div>
  );
}
