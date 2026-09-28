import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CopyPlus, Plus, Trash2 } from 'lucide-react';
import {
  availabilityApi,
  availabilityKeys,
  WEEKDAY_LABELS,
  type AvailabilityBlock,
  type Weekday,
} from '../../api/availability';
import { practiceApi, practiceKeys } from '../../api/practice';
import { useCan, useSession } from '../../auth/StaffAuth';
import { Button, IconButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Alert, EmptyState, ErrorState } from '../../ui/Display';
import { Field, Input, Select } from '../../ui/Form';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { useClinicians, type CalendarClinician } from '../calendar/clinicians';
import { fieldErrors } from '../clients/formUtils';
import {
  MAX_BLOCKS,
  WEEKDAYS,
  WORKWEEK,
  blocksFromRows,
  choiceKey,
  copyDay,
  locationChoices,
  newRow,
  rowsFromBlocks,
  serializeRows,
  suggestedRange,
  validateRows,
  weeklyHours,
  type AvailabilityRow,
  type LocationChoice,
} from './availabilityRules';
import { SettingsForm } from './SettingsForm';
import { timeZoneLabel } from './timeZones';
import { useDraft } from './useDraft';

interface WeekDraft {
  rows: AvailabilityRow[];
}

function DayEditor({
  weekday,
  rows,
  errors,
  choices,
  canAdd,
  onChange,
  onAdd,
  onRemove,
  onCopyToWeekdays,
}: {
  weekday: Weekday;
  rows: AvailabilityRow[];
  errors: Record<number, string>;
  choices: LocationChoice[];
  canAdd: boolean;
  onChange: (key: number, patch: Partial<AvailabilityRow>) => void;
  onAdd: () => void;
  onRemove: (key: number) => void;
  onCopyToWeekdays: () => void;
}) {
  const day = WEEKDAY_LABELS[weekday];
  return (
    <div className="grid gap-3 py-4 sm:grid-cols-[8rem_1fr]">
      <div>
        <p className="text-sm font-semibold text-sage-900">{day}</p>
        <p className="text-xs text-sage-500">
          {rows.length === 0 ? 'Unavailable' : `${rows.length} ${rows.length === 1 ? 'range' : 'ranges'}`}
        </p>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => {
          const error = errors[row.key];
          const errorId = error ? `availability-error-${row.key}` : undefined;
          const label = `${day} range ${index + 1}`;
          const current = choiceKey(row);
          // Keep a saved office that's no longer in use selectable until it's changed.
          const options = choices.some((choice) => choice.key === current)
            ? choices
            : [...choices, { key: current, label: 'In person (office no longer in use)', location_type: row.location_type, location_id: row.location_id }];
          return (
            <div key={row.key}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-32">
                  <Input
                    type="time"
                    step={300}
                    aria-label={`${label} start`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={errorId}
                    value={row.start_time}
                    onChange={(e) => onChange(row.key, { start_time: e.target.value })}
                  />
                </div>
                <span className="text-sage-400" aria-hidden="true">
                  –
                </span>
                <div className="w-32">
                  <Input
                    type="time"
                    step={300}
                    aria-label={`${label} end`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={errorId}
                    value={row.end_time}
                    onChange={(e) => onChange(row.key, { end_time: e.target.value })}
                  />
                </div>
                <Select
                  aria-label={`${label} location`}
                  value={current}
                  onChange={(e) => {
                    const choice = options.find((option) => option.key === e.target.value);
                    if (choice) onChange(row.key, { location_type: choice.location_type, location_id: choice.location_id });
                  }}
                  className="max-w-[12rem]"
                >
                  {options.map((choice) => (
                    <option key={choice.key} value={choice.key}>
                      {choice.label}
                    </option>
                  ))}
                </Select>
                <IconButton label={`Remove ${label}`} onClick={() => onRemove(row.key)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
              {error && (
                <p id={errorId} className="mt-1 text-sm text-red-600">
                  {error}
                </p>
              )}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" icon={<Plus className="h-4 w-4" />} onClick={onAdd} disabled={!canAdd}>
            Add hours
          </Button>
          {rows.length > 0 && (
            <Button variant="ghost" size="sm" icon={<CopyPlus className="h-4 w-4" />} onClick={onCopyToWeekdays}>
              Copy to Mon–Fri
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function WeekEditor({
  clinicianId,
  blocks,
  clinicians,
  onSelectClinician,
}: {
  clinicianId: number;
  blocks: AvailabilityBlock[];
  /** Clinicians whose hours this person can edit (a picker is shown for more than one). */
  clinicians: CalendarClinician[];
  onSelectClinician: (clinicianId: number) => void;
}) {
  const { staff } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: practiceKeys.settings, queryFn: practiceApi.settings });
  const locations = useQuery({ queryKey: practiceKeys.locations, queryFn: practiceApi.locations, staleTime: 5 * 60_000 });
  const choices = useMemo(() => locationChoices(locations.data ?? []), [locations.data]);
  const source = useMemo<WeekDraft>(() => ({ rows: rowsFromBlocks(blocks) }), [blocks]);
  const form = useDraft<WeekDraft>(source, (value) => serializeRows(value.rows));
  const rows = form.draft.rows;
  const errors = validateRows(rows);
  const hasErrors = Object.keys(errors).length > 0;
  const isMe = clinicianId === staff.id;
  const clinicianName = clinicians.find((clinician) => clinician.id === clinicianId)?.name ?? 'this clinician';

  const save = useMutation({
    mutationFn: () => availabilityApi.replace(clinicianId, blocksFromRows(rows)),
    onSuccess: (saved) => {
      queryClient.setQueryData(availabilityKeys.clinician(clinicianId), saved);
      toast.success(isMe ? 'Availability saved' : `Availability saved for ${clinicianName}`);
    },
    onError: (error) => {
      const found = fieldErrors(error);
      toast.error(Object.values(found)[0] ?? error.message);
    },
  });

  const setRows = (next: AvailabilityRow[]) => form.replace({ rows: next });
  const update = (key: number, patch: Partial<AvailabilityRow>) =>
    setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const hours = weeklyHours(rows);
  const days = new Set(rows.map((row) => row.weekday)).size;
  const zone = isMe ? `Times are in ${timeZoneLabel(staff.time_zone)}` : `Times are in ${clinicianName}'s time zone`;

  return (
    <SettingsForm
      title="Weekly availability"
      description={`When clients can request appointments online. ${zone}; clients see them in their own time zone.`}
      dirty={form.dirty}
      saving={save.isPending}
      onSubmit={() => {
        if (hasErrors) {
          toast.error('Fix the highlighted times before saving.');
          return;
        }
        save.mutate();
      }}
      onDiscard={form.discard}
    >
      {clinicians.length > 1 && (
        <Field
          label="Clinician"
          hint={form.dirty ? 'Save or discard your changes to switch clinicians.' : undefined}
          className="sm:max-w-sm"
        >
          {(props) => (
            <Select
              {...props}
              value={clinicianId}
              disabled={form.dirty}
              onChange={(event) => onSelectClinician(Number(event.target.value))}
            >
              {clinicians.map((clinician) => (
                <option key={clinician.id} value={clinician.id}>
                  {clinician.name}
                  {clinician.id === staff.id ? ' (you)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {settings.data && !settings.data.booking_enabled && (
        <Alert tone="info">
          Online requests are turned off for the practice, so clients can&apos;t book these hours yet.{' '}
          <Link to="?tab=booking" className="font-medium underline">
            Scheduling &amp; booking settings
          </Link>
        </Alert>
      )}
      <p className="text-sm text-sage-600">
        {rows.length === 0
          ? 'No hours set. Add hours to the days clients can book.'
          : `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours a week across ${days} ${days === 1 ? 'day' : 'days'}.`}
      </p>
      <div className="divide-y divide-sage-100 border-y border-sage-100">
        {WEEKDAYS.map((weekday) => {
          const dayRows = rows
            .filter((row) => row.weekday === weekday)
            .sort((a, b) => a.key - b.key);
          return (
            <DayEditor
              key={weekday}
              weekday={weekday}
              rows={dayRows}
              errors={errors}
              choices={choices}
              canAdd={rows.length < MAX_BLOCKS}
              onChange={update}
              onRemove={(key) => setRows(rows.filter((row) => row.key !== key))}
              onAdd={() => {
                const range = suggestedRange(dayRows);
                const last = dayRows[dayRows.length - 1];
                const place = last ?? choices[0];
                setRows([...rows, newRow(weekday, range.start_time, range.end_time, place.location_type, place.location_id)]);
              }}
              onCopyToWeekdays={() => setRows(copyDay(rows, weekday, WORKWEEK))}
            />
          );
        })}
      </div>
    </SettingsForm>
  );
}

/**
 * Weekly hours for online appointment requests; saving replaces the whole week. Clinicians edit
 * their own; staff who schedule for everyone can pick any clinician.
 */
export function AvailabilitySettings() {
  const { staff } = useSession();
  const schedulesEveryone = useCan('schedule_all');
  const team = useClinicians();
  const [chosenId, setChosenId] = useState<number | null>(staff.is_clinician ? staff.id : null);
  const editable = schedulesEveryone ? (team.clinicians ?? []) : (team.clinicians ?? []).filter((clinician) => clinician.id === staff.id);
  const clinicianId = chosenId ?? editable[0]?.id ?? null;

  const availability = useQuery({
    queryKey: availabilityKeys.clinician(clinicianId ?? 0),
    queryFn: () => availabilityApi.get(clinicianId ?? 0),
    enabled: clinicianId !== null,
  });

  if (clinicianId === null) {
    if (team.isPending) return <SectionSpinner />;
    return (
      <Card>
        {team.isError ? (
          <ErrorState error={team.error} onRetry={() => void team.refetch()} />
        ) : (
          <EmptyState title="No clinicians yet" description="Availability is set for each clinician once someone on the team sees clients." />
        )}
      </Card>
    );
  }
  if (availability.isPending) return <SectionSpinner />;
  if (availability.isError) {
    return (
      <Card>
        <ErrorState error={availability.error} onRetry={() => void availability.refetch()} />
      </Card>
    );
  }
  return (
    <WeekEditor
      key={clinicianId}
      clinicianId={clinicianId}
      blocks={availability.data}
      clinicians={editable}
      onSelectClinician={setChosenId}
    />
  );
}
