import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarClock, Repeat, UserRound } from 'lucide-react';
import {
  appointmentsApi,
  type Appointment,
  type AppointmentCreate,
  type AppointmentKind,
  type AppointmentUpdate,
  type ConflictDetail,
  type EditScope,
  type LocationType,
} from '../../api/appointments';
import { conflictFrom } from '../../api/booking';
import { clientKeys, clientsApi } from '../../api/clients';
import { practiceApi, practiceKeys, type Service } from '../../api/practice';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatMoney, parseMoneyToCents } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox, Field, Input, Select, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import {
  REPEAT_LABELS,
  addParticipant,
  hasChanges,
  isGroupService,
  locationFor,
  newAppointmentValues,
  removeParticipant,
  toCreatePayload,
  toUpdatePayload,
  validateValues,
  valuesFromAppointment,
  withBilledClient,
  withGroup,
  withKind,
  withService,
  type AppointmentFormValues,
  type FormErrors,
  type ParticipantValue,
  type RepeatOption,
} from './appointmentForm';
import { ConflictList, LocationIcon, ScopeChoice, SegmentedControl } from './CalendarParts';
import { useInvalidateCalendar, useServices } from './calendarHooks';
import { formatTimeRange, isDayKey, isTimeValue, startOfDayKey, zoneName, zonedDateTimeToIso } from './calendarMath';
import { useClinicians } from './clinicians';
import { ExternalBusyWarning } from './ExternalBusyWarning';
import { ParticipantsField } from './ParticipantsField';

export type AppointmentModalTarget =
  | { mode: 'create'; startsAt: string; clientId?: number | null; clinicianId?: number | null; kind?: AppointmentKind }
  | { mode: 'edit'; appointment: Appointment };

const LOCATION_OPTIONS: { value: LocationType; label: string }[] = [
  { value: 'video', label: 'Video' },
  { value: 'in_person', label: 'In person' },
  { value: 'phone', label: 'Phone' },
];

const LOCATION_DETAILS: Record<LocationType, { label: string; hint: string; placeholder: string }> = {
  video: {
    label: 'Video notes',
    hint: 'A private video room is created automatically.',
    placeholder: 'Optional',
  },
  in_person: {
    label: 'Address or room',
    hint: "Leave blank to use the office's address.",
    placeholder: 'e.g. Suite 204',
  },
  phone: {
    label: 'Phone details',
    hint: 'Shown to the clients, e.g. who calls whom.',
    placeholder: 'e.g. I will call you at your number on file',
  },
};

function serviceLabel(service: Pick<Service, 'code' | 'description'>): string {
  return service.code ? `${service.code} — ${service.description}` : service.description;
}

/** The service a new appointment starts with: the client's default, else the practice default. */
function defaultService(services: Service[], clientDefaultId: number | null | undefined): Service | null {
  const active = services.filter((service) => service.is_active);
  return (
    active.find((service) => service.id === clientDefaultId) ??
    active.find((service) => service.is_default) ??
    active[0] ??
    null
  );
}

/** "Alex Rivera billed $120.00" or "3 clients billed $40.00 each", from a saved appointment. */
export function billingSummary(appointment: Appointment): string {
  const billed = appointment.participants.filter((participant) => participant.billable);
  if (billed.length === 0) return '';
  if (billed.length === 1) return `${billed[0].client.name} billed ${formatMoney(billed[0].fee_cents)}`;
  const same = billed.every((participant) => participant.fee_cents === billed[0].fee_cents);
  return same ? `${billed.length} clients billed ${formatMoney(billed[0].fee_cents)} each` : `${billed.length} clients billed`;
}

function targetKey(target: AppointmentModalTarget): string {
  return target.mode === 'edit' ? `edit-${target.appointment.id}` : `new-${target.startsAt}-${target.clientId ?? ''}`;
}

/**
 * Create or edit an appointment or event. Renders nothing while `target` is null. After a save it
 * calls `onSaved` (which then decides what to show next) or, without one, `onClose`.
 */
export function AppointmentModal({
  target,
  timeZone,
  onClose,
  onSaved,
}: {
  target: AppointmentModalTarget | null;
  timeZone: string;
  onClose: () => void;
  onSaved?: (appointments: Appointment[]) => void;
}) {
  if (!target) return null;
  return <AppointmentModalContent key={targetKey(target)} target={target} timeZone={timeZone} onClose={onClose} onSaved={onSaved} />;
}

function AppointmentModalContent({
  target,
  timeZone,
  onClose,
  onSaved,
}: {
  target: AppointmentModalTarget;
  timeZone: string;
  onClose: () => void;
  onSaved?: (appointments: Appointment[]) => void;
}) {
  const toast = useToast();
  const { staff } = useSession();
  const canChooseClinician = useCan('schedule_all');
  const invalidate = useInvalidateCalendar();
  const services = useServices();
  const locations = useQuery({ queryKey: practiceKeys.locations, queryFn: practiceApi.locations, staleTime: 5 * 60_000 });
  const { clinicians } = useClinicians();
  const original = target.mode === 'edit' ? target.appointment : null;
  const isEdit = original !== null;

  const [values, setValues] = useState<AppointmentFormValues>(() => {
    if (target.mode === 'edit') return valuesFromAppointment(target.appointment, timeZone);
    const values = newAppointmentValues({
      startsAt: target.startsAt,
      timeZone,
      clinicianId: target.clinicianId ?? (staff.is_clinician ? staff.id : null),
    });
    return target.kind ? withKind(values, target.kind) : values;
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [conflict, setConflict] = useState<ConflictDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [scope, setScope] = useState<EditScope>('this');
  const [serviceTouched, setServiceTouched] = useState(isEdit);
  const [locationTouched, setLocationTouched] = useState(isEdit);
  const [linkedClientId, setLinkedClientId] = useState(target.mode === 'create' ? (target.clientId ?? null) : null);
  const lastAutoService = useRef('');
  const conflictRef = useRef<HTMLDivElement>(null);

  // A new appointment follows its first client's default service until a service is picked.
  const firstClientId = linkedClientId ?? values.participants[0]?.clientId ?? null;
  const clientDetail = useQuery({
    queryKey: clientKeys.detail(firstClientId ?? 0),
    queryFn: () => clientsApi.get(firstClientId ?? 0),
    enabled: !isEdit && firstClientId !== null && values.kind === 'appointment',
  });
  const firstClient = clientDetail.data?.id === firstClientId ? clientDetail.data : undefined;

  // A deep link (?new=1&client=ID) starts with that client once their name has loaded.
  useEffect(() => {
    if (linkedClientId === null || !firstClient) return;
    setValues((current) => addParticipant(current, { id: firstClient.id, name: `${firstClient.first_name} ${firstClient.last_name}` }));
    setLinkedClientId(null);
  }, [linkedClientId, firstClient]);

  useEffect(() => {
    if (serviceTouched || values.kind !== 'appointment' || !services.data) return;
    if (firstClientId !== null && !firstClient && !clientDetail.isError) return;
    const service = defaultService(services.data, firstClient?.default_service_id);
    const key = `${service?.id ?? 'none'}:${firstClientId ?? 'none'}`;
    if (lastAutoService.current === key) return;
    lastAutoService.current = key;
    setValues((current) => withService(current, service));
  }, [serviceTouched, values.kind, firstClientId, services.data, firstClient, clientDetail.isError]);

  useEffect(() => {
    if (locationTouched || !locations.data) return;
    setValues((current) => ({ ...current, locationId: locationFor(current.locationType, locations.data, current.locationId) }));
  }, [locationTouched, locations.data]);

  useEffect(() => {
    if (conflict) conflictRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [conflict]);

  const change = (next: (current: AppointmentFormValues) => AppointmentFormValues, fields: (keyof AppointmentFormValues)[]) => {
    setValues(next);
    setConflict(null);
    setFailure(null);
    setErrors((current) => {
      const remaining = { ...current };
      for (const field of fields) delete remaining[field];
      return remaining;
    });
  };
  const update = (changes: Partial<AppointmentFormValues>) =>
    change((current) => ({ ...current, ...changes }), Object.keys(changes) as (keyof AppointmentFormValues)[]);

  const serviceOptions = useMemo(() => {
    const all = services.data ?? [];
    return all.filter((service) => service.is_active || service.id === values.serviceId);
  }, [services.data, values.serviceId]);
  const selectedService = serviceOptions.find((service) => service.id === values.serviceId) ?? null;
  const groupService = isGroupService(selectedService);
  const locationOptions = (locations.data ?? []).filter((location) => location.is_active || location.id === values.locationId);
  const clinicianOptions = clinicians ?? [];
  const shared = values.participants.length > 1;

  // Fees come from the saved appointment; new clients' rates are set by the server on save.
  const feeOverride = values.fee.trim() === '' ? null : parseMoneyToCents(values.fee);
  const repriced = original !== null && (values.serviceId !== original.service_id || values.clinicianId !== original.clinician.id);
  const feeFor = (participant: ParticipantValue): number | null => {
    if (feeOverride !== null) return feeOverride;
    const before = original?.participants.find((item) => item.client.id === participant.clientId);
    return before?.billable && !repriced ? before.fee_cents : null;
  };

  const create = useMutation({ mutationFn: (payload: AppointmentCreate) => appointmentsApi.create(payload) });
  const save = useMutation({
    mutationFn: ({ id, payload, editScope }: { id: number; payload: AppointmentUpdate; editScope: EditScope }) =>
      appointmentsApi.update(id, payload, editScope),
  });
  const saving = create.isPending || save.isPending;

  const finish = async (saved: Appointment[], message: string) => {
    toast.success(message);
    await invalidate();
    if (onSaved) onSaved(saved);
    else onClose();
  };

  const handleError = (error: unknown) => {
    const detail = conflictFrom(error);
    if (detail) {
      setConflict(detail);
      return;
    }
    setFailure(error instanceof Error ? error.message : 'Something went wrong.');
  };

  const submit = async (allowConflicts: boolean) => {
    const found = validateValues(values, isEdit ? 'edit' : 'create');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      if (original) {
        const payload = toUpdatePayload(values, original, timeZone);
        if (!hasChanges(payload)) {
          onClose();
          return;
        }
        if (allowConflicts) payload.allow_conflicts = true;
        const saved = await save.mutateAsync({ id: original.id, payload, editScope: original.series_id ? scope : 'this' });
        await finish(saved, saved.length > 1 ? `${saved.length} appointments updated` : 'Changes saved');
      } else {
        const payload = toCreatePayload(values, timeZone);
        if (allowConflicts) payload.allow_conflicts = true;
        const saved = await create.mutateAsync(payload);
        const isEvent = values.kind === 'event';
        const scheduled =
          saved.length > 1 ? `${saved.length} ${isEvent ? 'events' : 'appointments'} scheduled` : `${isEvent ? 'Event' : 'Appointment'} scheduled`;
        const billing = saved[0] ? billingSummary(saved[0]) : '';
        await finish(saved, billing ? `${scheduled} · ${billing}${saved.length > 1 ? ' per session' : ''}` : scheduled);
      }
    } catch (error) {
      handleError(error);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(false);
  };

  const isAppointment = values.kind === 'appointment';
  const title = `${isEdit ? 'Edit' : 'New'} ${isAppointment ? 'appointment' : 'event'}`;
  const formId = `appointment-form-${targetKey(target)}`;
  const chosenTimes = useMemo(() => {
    const minutes = Number(values.duration);
    if (!isDayKey(values.date) || !isTimeValue(values.time) || !Number.isInteger(minutes) || minutes < 5) return null;
    const start = zonedDateTimeToIso(values.date, values.time, timeZone);
    return { start, end: new Date(Date.parse(start) + minutes * 60_000).toISOString() };
  }, [values.date, values.time, values.duration, timeZone]);
  const endsLabel = chosenTimes ? formatTimeRange(chosenTimes.start, chosenTimes.end, timeZone) : null;
  const chosenClinicianName =
    clinicianOptions.find((clinician) => clinician.id === values.clinicianId)?.name ?? original?.clinician.name ?? 'the clinician';

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={saving}>
        Cancel
      </Button>
      {conflict ? (
        <Button onClick={() => void submit(true)} loading={saving}>
          Save anyway
        </Button>
      ) : (
        <Button type="submit" form={formId} loading={saving}>
          {isEdit ? 'Save changes' : isAppointment ? 'Schedule' : 'Add event'}
        </Button>
      )}
    </>
  );

  return (
    <Modal open onClose={onClose} title={title} description={`Times in ${zoneName(timeZone)}`} size="lg" footer={footer}>
      {services.isLoading && !services.data ? (
        <SectionSpinner />
      ) : (
        <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
          {!isEdit && (
            <SegmentedControl
              label="Type"
              className="w-full sm:w-auto"
              value={values.kind}
              onChange={(kind) => {
                setValues((current) => withKind(current, kind));
                setConflict(null);
                setErrors({});
              }}
              options={[
                { value: 'appointment', label: <><UserRound className="h-4 w-4" aria-hidden="true" /> Appointment</> },
                { value: 'event', label: <><CalendarClock className="h-4 w-4" aria-hidden="true" /> Event</> },
              ]}
            />
          )}

          {original?.series_id && <ScopeChoice value={scope} onChange={setScope} action="Update" />}

          {services.isError && <Alert tone="danger">Couldn't load the practice's services: {services.error.message}</Alert>}
          {failure && <Alert tone="danger">{failure}</Alert>}

          {canChooseClinician && (
            <Field label="Clinician" required error={errors.clinicianId}>
              {(props) => (
                <Select
                  {...props}
                  value={values.clinicianId ?? ''}
                  onChange={(event) => update({ clinicianId: event.target.value ? Number(event.target.value) : null })}
                >
                  <option value="">Choose a clinician</option>
                  {values.clinicianId !== null && !clinicianOptions.some((clinician) => clinician.id === values.clinicianId) && (
                    <option value={values.clinicianId}>{original?.clinician.name ?? 'Loading…'}</option>
                  )}
                  {clinicianOptions.map((clinician) => (
                    <option key={clinician.id} value={clinician.id}>
                      {clinician.name}
                      {clinician.id === staff.id ? ' (you)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          {isAppointment ? (
            <Field
              label={shared ? 'Clients' : 'Client'}
              required
              error={errors.participants}
              hint={shared && !values.group ? 'A couples or family session bills one client, the identified patient.' : undefined}
            >
              {(props) =>
                linkedClientId !== null && !clientDetail.isError ? (
                  <Input id={props.id} disabled value="Loading client…" readOnly />
                ) : (
                  <>
                    {clientDetail.isError && linkedClientId !== null && (
                      <p className="mb-2 text-sm text-red-600">Couldn't load that client. Search for them instead.</p>
                    )}
                    <ParticipantsField
                      id={props.id}
                      describedBy={props['aria-describedby']}
                      invalid={props['aria-invalid']}
                      participants={values.participants}
                      group={values.group}
                      feeFor={feeFor}
                      onAdd={(client) => {
                        setLinkedClientId(null);
                        change((current) => addParticipant(current, client), ['participants']);
                      }}
                      onRemove={(clientId) => change((current) => removeParticipant(current, clientId), ['participants'])}
                      onBill={(clientId) => change((current) => withBilledClient(current, clientId), ['participants'])}
                    />
                  </>
                )
              }
            </Field>
          ) : (
            <Field label="Title" required error={errors.title}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  value={values.title}
                  onChange={(event) => update({ title: event.target.value })}
                  placeholder="e.g. Supervision, Lunch, Out of office"
                />
              )}
            </Field>
          )}

          {isAppointment && (
            <Checkbox
              label="Group session"
              description={
                groupService
                  ? 'Group psychotherapy bills every client.'
                  : 'Bill every client (e.g. group therapy). Otherwise one client is billed.'
              }
              checked={values.group || groupService}
              disabled={groupService}
              onChange={(event) => change((current) => withGroup(current, event.target.checked), ['participants', 'group'])}
            />
          )}

          {isAppointment && (values.group || shared) && (
            <Field
              label={values.group ? 'Group name (optional)' : 'Session name (optional)'}
              hint="Shown on the calendar instead of the clients' names."
            >
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  value={values.title}
                  onChange={(event) => update({ title: event.target.value })}
                  placeholder={values.group ? 'e.g. Tuesday DBT skills group' : 'e.g. Rivera family'}
                />
              )}
            </Field>
          )}

          {isAppointment && (
            <Field
              label="Service"
              hint={
                selectedService
                  ? `${selectedService.duration_minutes} min · standard rate ${formatMoney(selectedService.rate_cents)}`
                  : serviceOptions.length === 0
                    ? 'Add services in Settings to set codes, durations and rates.'
                    : undefined
              }
            >
              {(props) => (
                <Select
                  {...props}
                  value={values.serviceId ?? ''}
                  onChange={(event) => {
                    const service = serviceOptions.find((item) => item.id === Number(event.target.value)) ?? null;
                    setServiceTouched(true);
                    change((current) => withService(current, service), ['serviceId', 'duration', 'participants']);
                  }}
                >
                  <option value="">No service</option>
                  {serviceOptions.map((service) => (
                    <option key={service.id} value={service.id}>
                      {serviceLabel(service)}
                      {service.is_active ? '' : ' (inactive)'}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Date" required error={errors.date}>
              {(props) => <Input {...props} type="date" value={values.date} onChange={(event) => update({ date: event.target.value })} />}
            </Field>
            <Field label="Start time" required error={errors.time}>
              {(props) => (
                <Input {...props} type="time" step={300} value={values.time} onChange={(event) => update({ time: event.target.value })} />
              )}
            </Field>
            <Field label="Duration (min)" required error={errors.duration} hint={errors.duration ? undefined : endsLabel ?? undefined}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  inputMode="numeric"
                  min={5}
                  max={1440}
                  step={5}
                  value={values.duration}
                  onChange={(event) => update({ duration: event.target.value })}
                />
              )}
            </Field>
          </div>

          <ExternalBusyWarning
            clinicianId={values.clinicianId}
            startsAt={chosenTimes?.start ?? null}
            endsAt={chosenTimes?.end ?? null}
            whose={values.clinicianId === staff.id ? 'your' : `${chosenClinicianName}'s`}
            timeZone={timeZone}
          />

          <div className="space-y-3">
            <span className="block text-sm font-medium text-sage-800">Location</span>
            <SegmentedControl
              label="Location"
              className="w-full sm:w-auto"
              value={values.locationType}
              onChange={(locationType) =>
                update({ locationType, locationId: locationFor(locationType, locations.data ?? [], values.locationId) })
              }
              options={LOCATION_OPTIONS.map((option) => ({
                value: option.value,
                label: (
                  <>
                    <LocationIcon type={option.value} /> {option.label}
                  </>
                ),
              }))}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {locationOptions.length > 0 && (
                <Field label="Office" hint="Sets the place of service on claims.">
                  {(props) => (
                    <Select
                      {...props}
                      value={values.locationId ?? ''}
                      onChange={(event) => {
                        setLocationTouched(true);
                        update({ locationId: event.target.value ? Number(event.target.value) : null });
                      }}
                    >
                      <option value="">No office</option>
                      {locationOptions.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                          {location.is_active ? '' : ' (no longer in use)'}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label={LOCATION_DETAILS[values.locationType].label} hint={LOCATION_DETAILS[values.locationType].hint} error={errors.locationDetails}>
                {(props) => (
                  <Input
                    {...props}
                    maxLength={300}
                    placeholder={LOCATION_DETAILS[values.locationType].placeholder}
                    value={values.locationDetails}
                    onChange={(event) => update({ locationDetails: event.target.value })}
                  />
                )}
              </Field>
            </div>
          </div>

          {isAppointment && (
            <Field
              label="Fee override"
              error={errors.fee}
              hint={
                errors.fee
                  ? undefined
                  : isEdit
                    ? "Leave blank to keep each client's fee. A new fee applies to every billed client who hasn't been invoiced."
                    : "Leave blank to bill each client their rate: their custom rate, else the clinician's rate for the service."
              }
              className="sm:max-w-md"
            >
              {(props) => (
                <div className="relative sm:max-w-[12rem]">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-sage-500">$</span>
                  <Input
                    {...props}
                    inputMode="decimal"
                    className="pl-7"
                    value={values.fee}
                    onChange={(event) => update({ fee: event.target.value })}
                    placeholder="Their rate"
                  />
                </div>
              )}
            </Field>
          )}

          {!isEdit && <RepeatFields values={values} errors={errors} timeZone={timeZone} onChange={update} />}

          <Field label="Memo" hint="Internal only — never shared with clients.">
            {(props) => (
              <Textarea {...props} rows={2} value={values.memo} onChange={(event) => update({ memo: event.target.value })} />
            )}
          </Field>

          {isAppointment && (
            <Checkbox
              label={isEdit ? `Email ${shared ? 'the clients' : 'the client'} about this change` : `Email ${shared ? 'the clients' : 'the client'}`}
              description={
                isEdit
                  ? 'Sent only if the date, time, place or clinician changes, or to clients added or removed.'
                  : 'Send a confirmation with the date, time and location.'
              }
              checked={values.notifyClient}
              onChange={(event) => update({ notifyClient: event.target.checked })}
            />
          )}

          {conflict && (
            <div ref={conflictRef}>
              <ConflictList
                detail={conflict}
                timeZone={timeZone}
                footer={
                  <span className="text-amber-900">
                    {conflict.conflicts.length > 0
                      ? 'Change the time, or choose “Save anyway” to double-book.'
                      : 'Change the time, or choose “Save anyway” if that’s intended.'}
                  </span>
                }
              />
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}

function RepeatFields({
  values,
  errors,
  timeZone,
  onChange,
}: {
  values: AppointmentFormValues;
  errors: FormErrors;
  timeZone: string;
  onChange: (changes: Partial<AppointmentFormValues>) => void;
}) {
  const weekday = isDayKey(values.date)
    ? new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(startOfDayKey(values.date, timeZone))
    : null;
  return (
    <div className="space-y-3 rounded-lg border border-sage-100 bg-sage-50/60 p-3">
      <Field label="Repeat">
        {(props) => (
          <Select {...props} value={values.repeat} onChange={(event) => onChange({ repeat: event.target.value as RepeatOption })}>
            {(Object.keys(REPEAT_LABELS) as RepeatOption[]).map((option) => (
              <option key={option} value={option}>
                {option !== 'none' && option !== 'monthly' && weekday ? `${REPEAT_LABELS[option]} on ${weekday}` : REPEAT_LABELS[option]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {values.repeat !== 'none' && (
        <fieldset className="space-y-2">
          <legend className="mb-1 flex items-center gap-1.5 text-sm font-medium text-sage-800">
            <Repeat className="h-4 w-4" aria-hidden="true" /> Ends
          </legend>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-sage-800">
              <input
                type="radio"
                name="repeat-end"
                checked={values.repeatEnd === 'count'}
                onChange={() => onChange({ repeatEnd: 'count' })}
                className="h-4 w-4 border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
              />
              After
            </label>
            <Input
              aria-label="Number of occurrences"
              type="number"
              inputMode="numeric"
              min={2}
              max={100}
              className="w-20"
              disabled={values.repeatEnd !== 'count'}
              value={values.occurrences}
              aria-invalid={errors.occurrences ? true : undefined}
              onChange={(event) => onChange({ occurrences: event.target.value })}
            />
            <span className="text-sm text-sage-700">occurrences</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-sage-800">
              <input
                type="radio"
                name="repeat-end"
                checked={values.repeatEnd === 'until'}
                onChange={() => onChange({ repeatEnd: 'until' })}
                className="h-4 w-4 border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
              />
              On
            </label>
            <Input
              aria-label="Last date"
              type="date"
              className="w-44"
              min={values.date}
              disabled={values.repeatEnd !== 'until'}
              value={values.until}
              aria-invalid={errors.until ? true : undefined}
              onChange={(event) => onChange({ until: event.target.value })}
            />
          </div>
          {(errors.occurrences || errors.until) && (
            <p className="text-sm text-red-600" role="alert">
              {errors.occurrences ?? errors.until}
            </p>
          )}
          <p className="text-xs text-sage-500">Up to 100 appointments per series.</p>
        </fieldset>
      )}
    </div>
  );
}
