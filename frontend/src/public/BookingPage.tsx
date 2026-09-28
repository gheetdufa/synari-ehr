import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CalendarOff, CheckCircle2, LifeBuoy, Lock } from 'lucide-react';
import { ApiError } from '../api/client';
import {
  bookingKeys,
  publicBookingApi,
  type BookingPageInfo,
  type PricedService,
  type PublicBookingClinician,
  type PublicBookingInput,
  type Slot,
} from '../api/booking';
import {
  BookingSteps,
  BookingSummary,
  ClinicianPicker,
  ServicePicker,
  StepHeading,
  nameInitials,
} from '../client/appointments/BookingParts';
import { SlotPicker, type SlotSource } from '../client/appointments/SlotPicker';
import { chunkRange, dayKeyOf, formatDayKey, formatSlotTime, weekChunk } from '../client/appointments/slots';
import { Brand } from '../components/BrandMark';
import '../components/brand-mark.css';
import { formatMoney } from '../lib/format';
import { Button, LinkButton } from '../ui/Button';
import { Card } from '../ui/Card';
import { Alert, Avatar, EmptyState, ErrorState } from '../ui/Display';
import { Field, Input, Textarea } from '../ui/Form';
import { Spinner } from '../ui/Spinner';
import { GoodFaithEstimateNotice } from '../shared/GoodFaithEstimateNotice';

const MESSAGE_LIMIT = 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+().\-\s]{7,30}$/;

type Step = 'clinician' | 'service' | 'time' | 'details';

const STEP_LABELS: Record<Step, string> = {
  clinician: 'Clinician',
  service: 'Service',
  time: 'Time',
  details: 'Your details',
};

interface Details {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  email: string;
  phone: string;
  message: string;
  website: string;
}

type DetailErrors = Partial<Record<keyof Details, string>>;

const EMPTY_DETAILS: Details = {
  first_name: '',
  last_name: '',
  date_of_birth: '',
  email: '',
  phone: '',
  message: '',
  website: '',
};

function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function validate(details: Details): DetailErrors {
  const errors: DetailErrors = {};
  if (!details.first_name.trim()) errors.first_name = 'Enter your first name';
  if (!details.last_name.trim()) errors.last_name = 'Enter your last name';
  if (!details.date_of_birth) errors.date_of_birth = 'Enter your date of birth';
  else if (details.date_of_birth < '1900-01-01' || details.date_of_birth > localToday()) {
    errors.date_of_birth = 'Enter a valid date of birth';
  }
  if (!EMAIL.test(details.email.trim())) errors.email = 'Enter a valid email address';
  if (!PHONE.test(details.phone.trim())) errors.phone = 'Enter a phone number with at least 7 digits';
  return errors;
}

/** The clinician a `?clinician_id=` link asks for, when the parameter is a valid id. */
function linkedClinicianId(value: string | null): number | undefined {
  const id = Number(value);
  return value && Number.isInteger(id) && id > 0 ? id : undefined;
}

/** The service with the shortest session (the first one on ties). */
function shortestService(services: PricedService[]): PricedService | undefined {
  return services.reduce<PricedService | undefined>(
    (best, service) => (!best || service.duration_minutes < best.duration_minutes ? service : best),
    undefined,
  );
}

function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-sage-50">
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">{children}</main>
      <footer className="flex items-center justify-center gap-1.5 pb-8 text-xs text-sage-500 [&_.stack-mark]:w-4">
        Powered by <Brand wordClassName="text-xs font-semibold text-sage-700" />
      </footer>
    </div>
  );
}

function PracticeHeader({
  info,
  clinician,
  allClinicians,
}: {
  info: BookingPageInfo;
  /** The one clinician this page books with, when there's no choice to make. */
  clinician: PublicBookingClinician | null;
  /** The page listing every clinician, for a page opened from one clinician's link. */
  allClinicians: string | null;
}) {
  return (
    <header className="mb-6 text-center sm:mb-8">
      {clinician && <Avatar label={nameInitials(clinician.name)} className="mx-auto mb-3 h-14 w-14 text-lg" />}
      <p className="text-xs font-semibold uppercase tracking-wider text-primary-700">Request an appointment</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-sage-900 sm:text-3xl">{info.practice_name}</h1>
      {clinician && <p className="mt-1 text-sage-600">with {clinician.name}</p>}
      {allClinicians && (
        <Link to={allClinicians} className="mt-1 inline-block text-sm font-medium text-primary-700 hover:underline">
          See all clinicians
        </Link>
      )}
      {info.intro && (
        <p className="mx-auto mt-4 max-w-prose whitespace-pre-line text-sm leading-relaxed text-sage-700">{info.intro}</p>
      )}
    </header>
  );
}

/** "Next opening: Thu, Oct 2, 10:00 AM": the clinician's first open time for `service` over the
 * coming week (the same query the time step starts with, so it's cached for it). */
function NextOpening({
  slug,
  clinician,
  service,
}: {
  slug: string;
  clinician: PublicBookingClinician;
  service: PricedService;
}) {
  const [now] = useState(() => new Date());
  const range = chunkRange(weekChunk(0, clinician.time_zone, now), clinician.id, service.id);
  const slots = useQuery({
    queryKey: bookingKeys.publicSlots(slug, range),
    queryFn: () => publicBookingApi.slots(slug, range),
    staleTime: 60_000,
  });
  if (slots.isError) return null;
  if (slots.isPending) return <>Checking availability…</>;
  const first = [...slots.data].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0];
  if (!first) return <>No openings in the next week</>;
  const zone = clinician.time_zone;
  return (
    <>
      Next opening: {formatDayKey(dayKeyOf(first.starts_at, zone))}, {formatSlotTime(first.starts_at, zone)}
    </>
  );
}

/** What a clinician card says: their services with fees, and when they're next open. */
function ClinicianDetails({ slug, clinician }: { slug: string; clinician: PublicBookingClinician }) {
  const service = shortestService(clinician.services);
  return (
    <>
      <span className="block">
        {clinician.services.map((item) => `${item.description} (${servicePrice(item.rate_cents)})`).join(' · ')}
      </span>
      {service && (
        <span className="mt-1 flex items-center gap-1.5 text-xs font-medium text-primary-700">
          <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <NextOpening slug={slug} clinician={clinician} service={service} />
        </span>
      )}
    </>
  );
}

/**
 * Public booking page (/book/:slug): new clients pick a clinician, a service and an open time,
 * then send their details. The practice accepts or declines; nothing is booked until then. A
 * `?clinician_id=` link books with that clinician only.
 */
/** A service's price on the booking page; free consultations say so. */
export function servicePrice(rateCents: number): string {
  return rateCents === 0 ? 'free' : formatMoney(rateCents);
}

export default function BookingPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const linkedId = linkedClinicianId(params.get('clinician_id'));
  const page = useQuery({
    queryKey: bookingKeys.publicPage(slug, linkedId),
    queryFn: () => publicBookingApi.page(slug, linkedId),
  });

  const practiceName = page.data?.practice_name;
  useEffect(() => {
    if (!practiceName) return;
    const previous = document.title;
    document.title = `Request an appointment · ${practiceName}`;
    return () => {
      document.title = previous;
    };
  }, [practiceName]);

  if (page.isPending) {
    return (
      <PublicShell>
        <div className="flex justify-center py-24 text-primary-600">
          <Spinner className="h-8 w-8" />
        </div>
      </PublicShell>
    );
  }

  if (page.isError) {
    const notFound = page.error instanceof ApiError && page.error.status === 404;
    return (
      <PublicShell>
        <Card>
          {notFound ? (
            <EmptyState
              icon={<CalendarOff />}
              title="Online booking isn't available"
              description="This booking page doesn't exist or isn't taking requests right now. Please contact the practice directly to schedule."
            />
          ) : (
            <ErrorState error={page.error} onRetry={() => void page.refetch()} />
          )}
        </Card>
      </PublicShell>
    );
  }

  const info = page.data;
  const allClinicians = `/book/${encodeURIComponent(slug)}`;
  const only = info.clinicians.length === 1 ? info.clinicians[0] : null;
  let body: ReactNode;
  if (info.clinicians.length > 0) {
    body = <BookingFlow key={linkedId ?? 'all'} slug={slug} info={info} />;
  } else if (linkedId !== undefined) {
    body = (
      <Card>
        <EmptyState
          icon={<CalendarOff />}
          title="This clinician isn't taking online requests"
          description={`They may not be accepting new clients right now. You can still request an appointment with someone else at ${info.practice_name}.`}
          action={
            <LinkButton to={allClinicians} variant="secondary">
              See all clinicians
            </LinkButton>
          }
        />
      </Card>
    );
  } else {
    body = (
      <Card>
        <EmptyState
          icon={<CalendarOff />}
          title="No appointments are open for online requests"
          description="Please contact the practice directly to schedule."
        />
      </Card>
    );
  }

  return (
    <PublicShell>
      <PracticeHeader info={info} clinician={only} allClinicians={linkedId !== undefined && only ? allClinicians : null} />
      {body}
      {info.gfe_notice && <GoodFaithEstimateNotice className="mt-6" />}
    </PublicShell>
  );
}

function BookingFlow({ slug, info }: { slug: string; info: BookingPageInfo }) {
  const queryClient = useQueryClient();
  const choosesClinician = info.clinicians.length > 1;
  const steps: Step[] = choosesClinician ? ['clinician', 'service', 'time', 'details'] : ['service', 'time', 'details'];
  const [step, setStep] = useState<Step>(steps[0]);
  const [clinician, setClinician] = useState<PublicBookingClinician | null>(choosesClinician ? null : info.clinicians[0]);
  const [service, setService] = useState<PricedService | null>(() =>
    clinician?.services.length === 1 ? clinician.services[0] : null,
  );
  const [slot, setSlot] = useState<Slot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const source = useMemo<SlotSource>(
    () => ({
      key: (range) => bookingKeys.publicSlots(slug, range),
      fetch: (range) => publicBookingApi.slots(slug, range),
    }),
    [slug],
  );

  const submit = useMutation({
    mutationFn: (input: PublicBookingInput) => publicBookingApi.request(slug, input),
    onError: (error) => {
      if (!(error instanceof ApiError) || error.status !== 409) return;
      // Keep the taken slot so the picker reopens on its week; it drops out of the refetched list.
      setNotice(error.message);
      setStep('time');
      void queryClient.invalidateQueries({ queryKey: ['booking', slug, 'slots'] });
    },
  });

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step, submit.isSuccess]);

  const goTo = (next: Step) => {
    submit.reset();
    setStep(next);
  };

  const chooseClinician = (next: PublicBookingClinician) => {
    if (next.id !== clinician?.id) {
      setClinician(next);
      setService(next.services.length === 1 ? next.services[0] : null);
      setSlot(null);
      setNotice(null);
    }
    goTo('service');
  };

  const changeClinician = choosesClinician ? () => goTo('clinician') : undefined;

  if (submit.isSuccess && clinician && service && slot) {
    return (
      <Card className="px-5 py-8 sm:px-8">
        <div className="mb-6 text-center">
          <CheckCircle2 className="mx-auto mb-3 h-12 w-12 text-emerald-600" aria-hidden="true" />
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-sage-900 focus:outline-none">
            Request sent
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-sage-600">
            {info.practice_name} will review your request and confirm by email at{' '}
            <span className="font-medium text-sage-800">{details.email.trim()}</span>. Your time isn't reserved until
            it's confirmed.
          </p>
        </div>
        <BookingSummary
          clinicianName={clinician.name}
          service={service}
          slot={slot}
          timeZone={clinician.time_zone}
          locations={info.locations}
        />
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-6">
      <BookingSteps
        steps={steps.map((id) => STEP_LABELS[id])}
        current={steps.indexOf(step)}
        onStepSelect={(index) => goTo(steps[index])}
      />

      {step === 'clinician' && (
        <>
          <StepHeading headingRef={headingRef} title="Choose a clinician" description="Who would you like to see?" />
          <ClinicianPicker
            clinicians={info.clinicians}
            selectedId={clinician?.id ?? null}
            onSelect={chooseClinician}
            details={(item) => <ClinicianDetails slug={slug} clinician={item} />}
          />
        </>
      )}

      {step === 'service' && clinician && (
        <>
          <StepHeading
            headingRef={headingRef}
            title="Choose a service"
            description={choosesClinician ? `With ${clinician.name}` : 'What would you like to book?'}
            onBack={changeClinician}
          />
          <ServicePicker
            services={clinician.services}
            selectedId={service?.id ?? null}
            onSelect={(next) => {
              if (next.id !== service?.id) setSlot(null);
              setService(next);
              setNotice(null);
              goTo('time');
            }}
          />
        </>
      )}

      {step === 'time' && clinician && service && (
        <>
          <StepHeading
            headingRef={headingRef}
            title="Choose a time"
            description={choosesClinician ? `${service.description} with ${clinician.name}` : service.description}
            onBack={() => goTo('service')}
          />
          {notice && (
            <div className="mb-4">
              <Alert tone="warning">{notice}</Alert>
            </div>
          )}
          <SlotPicker
            source={source}
            clinicianId={clinician.id}
            serviceId={service.id}
            timeZone={clinician.time_zone}
            locations={info.locations}
            selected={slot}
            onSelect={(next) => {
              setSlot(next);
              setNotice(null);
              goTo('details');
            }}
          />
        </>
      )}

      {step === 'details' && clinician && service && slot && (
        <>
          <StepHeading
            headingRef={headingRef}
            title="Your details"
            description="So the practice can confirm your appointment."
            onBack={() => goTo('time')}
          />
          <div className="mb-5">
            <BookingSummary
              clinicianName={clinician.name}
              service={service}
              slot={slot}
              timeZone={clinician.time_zone}
              locations={info.locations}
              onChangeClinician={changeClinician}
              onChangeService={() => goTo('service')}
              onChangeTime={() => goTo('time')}
            />
          </div>
          <DetailsForm
            details={details}
            onChange={setDetails}
            practiceName={info.practice_name}
            submitting={submit.isPending}
            error={submit.isError && !(submit.error instanceof ApiError && submit.error.status === 409) ? submit.error : null}
            onSubmit={(values) =>
              submit.mutate({
                clinician_id: clinician.id,
                service_id: service.id,
                starts_at: slot.starts_at,
                location_type: slot.location_type,
                first_name: values.first_name.trim(),
                last_name: values.last_name.trim(),
                date_of_birth: values.date_of_birth,
                email: values.email.trim(),
                phone: values.phone.trim(),
                message: values.message.trim(),
                website: values.website,
              })
            }
          />
        </>
      )}
    </Card>
  );
}

function DetailsForm({
  details,
  onChange,
  practiceName,
  submitting,
  error,
  onSubmit,
}: {
  details: Details;
  onChange: (details: Details) => void;
  practiceName: string;
  submitting: boolean;
  error: Error | null;
  onSubmit: (details: Details) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<DetailErrors>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);

  const set = (field: keyof Details) => (value: string) => {
    onChange({ ...details, [field]: value });
    if (errors[field]) setErrors({ ...errors, [field]: undefined });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(details);
    setErrors(found);
    setAttempt((count) => count + 1);
    if (Object.keys(found).length === 0) onSubmit(details);
  };

  return (
    <form ref={formRef} noValidate onSubmit={handleSubmit} className="relative space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" required error={errors.first_name}>
          {(props) => (
            <Input
              {...props}
              autoComplete="given-name"
              maxLength={100}
              value={details.first_name}
              onChange={(event) => set('first_name')(event.target.value)}
            />
          )}
        </Field>
        <Field label="Last name" required error={errors.last_name}>
          {(props) => (
            <Input
              {...props}
              autoComplete="family-name"
              maxLength={100}
              value={details.last_name}
              onChange={(event) => set('last_name')(event.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Date of birth" required error={errors.date_of_birth}>
        {(props) => (
          <Input
            {...props}
            type="date"
            autoComplete="bday"
            min="1900-01-01"
            max={localToday()}
            value={details.date_of_birth}
            onChange={(event) => set('date_of_birth')(event.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" required error={errors.email} hint="The practice will confirm here.">
          {(props) => (
            <Input
              {...props}
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={254}
              value={details.email}
              onChange={(event) => set('email')(event.target.value)}
            />
          )}
        </Field>
        <Field label="Phone" required error={errors.phone}>
          {(props) => (
            <Input
              {...props}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={30}
              value={details.phone}
              onChange={(event) => set('phone')(event.target.value)}
            />
          )}
        </Field>
      </div>
      <Field
        label="Message (optional)"
        hint={`Anything the practice should know before confirming. ${details.message.length}/${MESSAGE_LIMIT}`}
      >
        {(props) => (
          <Textarea
            {...props}
            rows={3}
            maxLength={MESSAGE_LIMIT}
            value={details.message}
            onChange={(event) => set('message')(event.target.value)}
          />
        )}
      </Field>

      <div aria-hidden="true" className="absolute -left-[10000px] top-0 h-px w-px overflow-hidden">
        <label>
          Website
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={details.website}
            onChange={(event) => set('website')(event.target.value)}
          />
        </label>
      </div>

      <div className="space-y-2 rounded-lg bg-sage-50 px-3 py-2.5 text-xs text-sage-600">
        <p className="flex items-start gap-2">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Your details are sent securely and only to {practiceName}.
        </p>
        <p className="flex items-start gap-2">
          <LifeBuoy className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          This form isn't monitored for emergencies. If you're in crisis, call or text 988 (US) or your local emergency
          number.
        </p>
      </div>

      {error && <Alert tone="danger">{error.message}</Alert>}

      <Button type="submit" loading={submitting} className="w-full">
        Send request
      </Button>
    </form>
  );
}
