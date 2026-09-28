import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import {
  importsApi,
  type ClinicianChoice,
  type ClinicianInvite,
  type ExistingReview,
  type ImportJob,
  type ImportKindInfo,
  type ImportOptions,
  type ImportPreview,
  type MatchReview,
  type PreviewClinician,
} from '../../../api/imports';
import { teamApi, teamKeys, type TeamMember } from '../../../api/team';
import { useCan, useSession } from '../../../auth/StaffAuth';
import { formatDateTime, formatMoney } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card, CardBody, CardHeader } from '../../../ui/Card';
import { Alert, Badge, Table, Td, Th } from '../../../ui/Display';
import { Checkbox, Field, Input, Select } from '../../../ui/Form';
import { ConfirmDialog } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';
import { countLabel, initialOptions, kindLabel, startBlockers } from './importLogic';
import { UploadStep } from './UploadStep';
import { useStoreImportJob } from './useImportJob';

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-sage-100 bg-sage-50/50 px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-sage-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-sage-900">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-sage-500">{hint}</dd>}
    </div>
  );
}

/** Totals of what the import will create or update. */
function Counts({ preview }: { preview: ImportPreview }) {
  const { counts } = preview;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Stat label="New clients" value={counts.clients_new.toLocaleString('en-US')} />
      <Stat label="Existing clients to update" value={counts.clients_existing.toLocaleString('en-US')} />
      <Stat label="Contacts" value={counts.contacts.toLocaleString('en-US')} />
      <Stat
        label="Insurance policies"
        value={counts.insurance_policies.toLocaleString('en-US')}
        hint={`${countLabel(counts.clients_with_diagnoses, 'client')} with diagnoses`}
      />
      <Stat
        label="Past appointments"
        value={counts.appointments.toLocaleString('en-US')}
        hint={
          counts.future_appointments_skipped > 0
            ? `${countLabel(counts.future_appointments_skipped, 'future appointment')} skipped`
            : undefined
        }
      />
      <Stat
        label="Documents"
        value={counts.documents.toLocaleString('en-US')}
        hint={counts.documents_skipped > 0 ? `${countLabel(counts.documents_skipped, 'file')} can't be imported` : undefined}
      />
      <Stat label="Psychotherapy notes" value={counts.psychotherapy_notes.toLocaleString('en-US')} hint="Primary clinician only" />
      <Stat label="Secure message transcripts" value={counts.secure_messages.toLocaleString('en-US')} />
      <Stat
        label="Opening balances"
        value={counts.balances.toLocaleString('en-US')}
        hint={`${formatMoney(counts.balance_total_cents)} in total`}
      />
    </dl>
  );
}

/** A collapsible section for details most people won't need. */
function Disclosure({ title, children, id }: { title: ReactNode; children: ReactNode; id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-5 py-4 text-left text-base font-semibold text-sage-900 hover:bg-sage-50"
      >
        <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`} />
        {title}
      </button>
      {open && (
        <div id={id} className="border-t border-sage-100">
          {children}
        </div>
      )}
    </Card>
  );
}

/** Folders of the export zip and a few rows from each spreadsheet. */
function FoundInFiles({ preview, kinds }: { preview: ImportPreview; kinds: ImportKindInfo[] | undefined }) {
  return (
    <div className="space-y-6 px-5 py-4">
      {preview.folders.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-sage-800">Complete export</h3>
          <Table>
            <thead>
              <tr>
                <Th>Folder</Th>
                <Th className="text-right">Clients</Th>
                <Th className="text-right">Files</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sage-100">
              {preview.folders.map((folder) => (
                <tr key={folder.name}>
                  <Td>{folder.name}</Td>
                  <Td className="text-right">{folder.clients.toLocaleString('en-US')}</Td>
                  <Td className="text-right">{folder.files.toLocaleString('en-US')}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
      {preview.files.map((file) => {
        const labels = Object.fromEntries(
          (kinds?.find((info) => info.kind === file.kind)?.fields ?? []).map((field) => [field.name, field.label]),
        );
        const columns = [...new Set(file.sample.flatMap((row) => Object.keys(row)))];
        return (
          <section key={file.file_id}>
            <h3 className="text-sm font-semibold text-sage-800">
              {file.filename} <span className="font-normal text-sage-500">· {kindLabel(file.kind, kinds)}</span>
            </h3>
            <p className="mb-2 text-sm text-sage-600">{countLabel(file.rows, 'row')}</p>
            {file.missing_required.length > 0 && (
              <p className="mb-2 text-sm text-amber-700">Missing columns: {file.missing_required.join(', ')}</p>
            )}
            {file.sample.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <Th key={column}>{labels[column] ?? column}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-sage-100">
                  {file.sample.map((row, index) => (
                    <tr key={index}>
                      {columns.map((column) => (
                        <Td key={column}>{row[column] ?? ''}</Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RadioOption({
  name,
  value,
  checked,
  onChange,
  label,
  detail,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  label: ReactNode;
  detail?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-0.5 h-4 w-4 accent-primary-600"
      />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium text-sage-800">{label}</span>
        {detail && <span className="block text-sage-500">{detail}</span>}
      </label>
    </div>
  );
}

function MatchQuestion({
  review,
  decision,
  onDecide,
}: {
  review: MatchReview;
  decision: string;
  onDecide: (value: string) => void;
}) {
  const name = `match-${review.id}`;
  return (
    <fieldset className="space-y-2 px-5 py-4">
      <legend className="text-sm text-sage-800">
        <span className="font-semibold">{review.name}</span>{' '}
        <span className="text-sage-600">
          in {review.sources.join(', ')} {review.reason === 'same_name' ? 'has the same name as' : 'looks like'}:
        </span>
      </legend>
      {review.candidates.map((candidate) => (
        <RadioOption
          key={candidate.key}
          name={name}
          value={candidate.key}
          checked={decision === candidate.key}
          onChange={onDecide}
          label={`Same person as ${candidate.name}`}
          detail={candidate.detail}
        />
      ))}
      <RadioOption name={name} value="" checked={decision === ''} onChange={onDecide} label="A different person (keep separate)" />
    </fieldset>
  );
}

function ExistingQuestion({
  review,
  decision,
  onDecide,
}: {
  review: ExistingReview;
  decision: number;
  onDecide: (value: number) => void;
}) {
  const name = `existing-${review.key}`;
  return (
    <fieldset className="space-y-2 px-5 py-4">
      <legend className="text-sm text-sage-800">
        <span className="font-semibold">{review.name}</span>
        {review.detail && <span className="text-sage-600"> ({review.detail})</span>}{' '}
        <span className="text-sage-600">may already be in Synari:</span>
      </legend>
      {review.candidates.map((candidate) => (
        <RadioOption
          key={candidate.key}
          name={name}
          value={candidate.key}
          checked={decision === Number(candidate.key)}
          onChange={(value) => onDecide(Number(value))}
          label={`Update ${candidate.name}`}
          detail={candidate.detail}
        />
      ))}
      <RadioOption name={name} value="0" checked={decision === 0} onChange={() => onDecide(0)} label="Add as a new client" />
    </fieldset>
  );
}

const DEFAULT_CHOICE = 'default';
const INVITE_CHOICE = 'invite';

function choiceValue(choice: ClinicianChoice | undefined): string {
  if (choice?.invite) return INVITE_CHOICE;
  if (choice?.staff_id != null) return `staff:${choice.staff_id}`;
  return DEFAULT_CHOICE;
}

function ClinicianRow({
  clinician,
  choice,
  team,
  canInvite,
  onChange,
}: {
  clinician: PreviewClinician;
  choice: ClinicianChoice | undefined;
  team: TeamMember[];
  canInvite: boolean;
  onChange: (choice: ClinicianChoice) => void;
}) {
  const value = choiceValue(choice);
  const invite: ClinicianInvite = choice?.invite ?? { first_name: '', last_name: '', email: '' };
  const setInvite = (change: Partial<ClinicianInvite>) => onChange({ invite: { ...invite, ...change } });
  const [first = '', ...rest] = clinician.name.split(/\s+/);
  return (
    <li className="space-y-3 px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-sage-900">{clinician.name}</p>
            {clinician.matched && <Badge tone="success">Matched</Badge>}
          </div>
          <p className="text-sm text-sage-600">
            {countLabel(clinician.clients, 'client')} · {countLabel(clinician.appointments, 'session')}
          </p>
        </div>
        <Select
          aria-label={`Synari clinician for ${clinician.name}`}
          className="sm:w-72"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            if (next === DEFAULT_CHOICE) onChange({});
            else if (next === INVITE_CHOICE)
              onChange({ invite: { first_name: first, last_name: rest.join(' '), email: '' } });
            else onChange({ staff_id: Number(next.slice('staff:'.length)) });
          }}
        >
          <option value={DEFAULT_CHOICE}>Use the default clinician</option>
          {choice?.staff_id != null && !team.some((member) => member.id === choice.staff_id) && (
            <option value={value}>{team.length > 0 ? 'Someone no longer on the team' : 'Loading…'}</option>
          )}
          {team.map((member) => (
            <option key={member.id} value={`staff:${member.id}`}>
              {member.display_name}
              {member.status === 'invited' ? ' (invited)' : ''}
            </option>
          ))}
          {(canInvite || value === INVITE_CHOICE) && <option value={INVITE_CHOICE}>Invite a new clinician…</option>}
        </Select>
      </div>
      {value === INVITE_CHOICE && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="First name" required>
            {(props) => <Input {...props} value={invite.first_name} onChange={(event) => setInvite({ first_name: event.target.value })} />}
          </Field>
          <Field label="Last name" required>
            {(props) => <Input {...props} value={invite.last_name} onChange={(event) => setInvite({ last_name: event.target.value })} />}
          </Field>
          <Field label="Email" required hint="They'll get an invitation to join when the import runs.">
            {(props) => (
              <Input {...props} type="email" value={invite.email} onChange={(event) => setInvite({ email: event.target.value })} />
            )}
          </Field>
        </div>
      )}
    </li>
  );
}

const OPTION_FIELDS: { key: keyof ImportOptions; label: string; description: string }[] = [
  {
    key: 'create_missing_clients',
    label: 'Add clients found only in other files',
    description: 'Clients named only in appointment, balance or document files are added using their name.',
  },
  { key: 'import_contacts', label: 'Contacts', description: 'Emergency contacts, guardians and other contacts.' },
  { key: 'import_insurance', label: 'Insurance', description: 'Payers and policies (member, group and copay when available).' },
  {
    key: 'import_appointments',
    label: 'Past appointments',
    description: 'History only: never invoiced, claimed or reminded.',
  },
  {
    key: 'import_documents',
    label: 'Documents',
    description: 'Files from the Complete export, filed under their SimplePractice folder.',
  },
  {
    key: 'import_balances',
    label: 'Opening balances',
    description: 'One invoice per client for what they owed in SimplePractice. No emails are sent.',
  },
];

/**
 * Review the analysis: totals, warnings, who's who (possible duplicates and existing clients),
 * which Synari clinician each SimplePractice clinician becomes, and what to import. Saving the
 * choices analyzes again so the totals reflect them.
 */
export function ReviewStep({ job, kinds }: { job: ImportJob & { preview: ImportPreview }; kinds: ImportKindInfo[] | undefined }) {
  const preview = job.preview;
  const { staff } = useSession();
  const canInvite = useCan('manage_team');
  const toast = useToast();
  const store = useStoreImportJob();
  const [options, setOptions] = useState<ImportOptions>(() => initialOptions(job));
  const [confirming, setConfirming] = useState(false);
  const team = useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list });
  const clinicians = (team.data ?? []).filter((member) => member.is_clinician && member.status !== 'deactivated');

  const set = (change: Partial<ImportOptions>) => setOptions((current) => ({ ...current, ...change }));

  const refresh = useMutation({
    mutationFn: async () => {
      await importsApi.update(job.id, { options });
      return importsApi.analyze(job.id);
    },
    onSuccess: store,
    onError: (error) => toast.error(error),
  });
  const start = useMutation({
    mutationFn: async () => {
      await importsApi.update(job.id, { options });
      return importsApi.start(job.id);
    },
    onSuccess: (updated) => {
      setConfirming(false);
      store(updated);
    },
    onError: (error) => {
      setConfirming(false);
      toast.error(error);
    },
  });

  const blockers = startBlockers(preview, options);
  const busy = refresh.isPending || start.isPending;
  const reviews = preview.matches.length + preview.existing.length;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Here's what we found"
          description={`Analyzed ${formatDateTime(preview.analyzed_at, staff.time_zone)}. Review the details below, then start the import.`}
        />
        <CardBody>
          <Counts preview={preview} />
        </CardBody>
      </Card>

      {preview.warnings.length > 0 && (
        <Card>
          <CardHeader title="Warnings" description="Worth checking before you import. None of these stop the import." />
          <ul className="divide-y divide-sage-100">
            {preview.warnings.map((warning) => (
              <li key={`${warning.code}-${warning.message}`} className="flex items-start justify-between gap-3 px-5 py-3 text-sm">
                <span className="text-sage-800">{warning.message}</span>
                {warning.count > 1 && <Badge tone="warning">{warning.count.toLocaleString('en-US')}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {reviews > 0 && (
        <Card>
          <CardHeader
            title="Confirm who's who"
            description="SimplePractice files don't share client ids, so we match people by name, birth date, email and phone. Confirm these possible matches; anything you don't confirm is kept separate."
          />
          <div className="divide-y divide-sage-100">
            {preview.matches.map((review) => (
              <MatchQuestion
                key={review.id}
                review={review}
                decision={options.matches[review.id] ?? ''}
                onDecide={(value) => set({ matches: { ...options.matches, [review.id]: value } })}
              />
            ))}
            {preview.existing.map((review) => (
              <ExistingQuestion
                key={review.key}
                review={review}
                decision={options.existing[review.key] ?? 0}
                onDecide={(value) => set({ existing: { ...options.existing, [review.key]: value } })}
              />
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Clinicians"
          description="Clients get their SimplePractice clinician as primary clinician, and past sessions go on that clinician's calendar."
        />
        {preview.clinicians.length > 0 && (
          <ul className="divide-y divide-sage-100 border-b border-sage-100">
            {preview.clinicians.map((clinician) => (
              <ClinicianRow
                key={clinician.key}
                clinician={clinician}
                choice={options.clinicians[clinician.key]}
                team={clinicians}
                canInvite={canInvite}
                onChange={(choice) => set({ clinicians: { ...options.clinicians, [clinician.key]: choice } })}
              />
            ))}
          </ul>
        )}
        <CardBody>
          <Field
            label="Default clinician"
            hint="For clients and sessions without a SimplePractice clinician, or whose clinician uses the default."
          >
            {(props) => (
              <Select
                {...props}
                className="sm:w-72"
                value={options.default_clinician_id ?? ''}
                onChange={(event) => set({ default_clinician_id: event.target.value ? Number(event.target.value) : null })}
              >
                <option value="">No default</option>
                {clinicians.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.display_name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What to import" />
        <CardBody className="space-y-4">
          {OPTION_FIELDS.map((field) => (
            <Checkbox
              key={field.key}
              label={field.label}
              description={field.description}
              checked={Boolean(options[field.key])}
              onChange={(event) => set({ [field.key]: event.target.checked })}
            />
          ))}
        </CardBody>
      </Card>

      <Disclosure id={`found-${job.id}`} title="What's in each file">
        <FoundInFiles preview={preview} kinds={kinds} />
      </Disclosure>

      <Disclosure id={`files-${job.id}`} title="Add or change files">
        <div className="space-y-4 px-5 py-4">
          <Alert tone="info">Changing files, their columns or the zip password needs a new analysis.</Alert>
          <UploadStep job={job} kinds={kinds} compact />
        </div>
      </Disclosure>

      <Card>
        <CardBody className="space-y-3">
          {blockers.length > 0 && (
            <Alert tone="warning" title="Before importing">
              <ul className="list-disc space-y-1 pl-5">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" loading={refresh.isPending} disabled={busy} onClick={() => refresh.mutate()}>
              Save and update preview
            </Button>
            <Button disabled={busy || blockers.length > 0} onClick={() => setConfirming(true)}>
              Start import
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirming}
        title="Start the import?"
        message="Clients, contacts, insurance, past appointments, documents and balances are added to Synari with the choices above. You can follow the progress here, and nothing is emailed to clients."
        confirmLabel="Start import"
        loading={start.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => start.mutate()}
      />
    </div>
  );
}
