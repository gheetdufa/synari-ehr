import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarOff, MessageSquare } from 'lucide-react';
import { ApiError } from '../../api/client';
import {
  bookingKeys,
  portalBookingApi,
  type BookableService,
  type BookingLocation,
  type PortalBookingClinician,
  type PortalBookingInput,
  type Slot,
} from '../../api/booking';
import { usePortalClient } from '../../auth/ClientAuth';
import { Button, LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Alert, EmptyState, ErrorState, PageHeader } from '../../ui/Display';
import { Field, Textarea } from '../../ui/Form';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { BookingSteps, BookingSummary, ClinicianPicker, ServicePicker, StepHeading } from './BookingParts';
import { SlotPicker, type SlotSource } from './SlotPicker';
import { formatDuration } from './slots';

const MESSAGE_LIMIT = 1000;

const PORTAL_SLOTS: SlotSource = { key: bookingKeys.portalSlots, fetch: portalBookingApi.slots };

type Step = 'clinician' | 'service' | 'time' | 'confirm';

const STEP_LABELS: Record<Step, string> = {
  clinician: 'Clinician',
  service: 'Service',
  time: 'Time',
  confirm: 'Confirm',
};

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function BookingUnavailable({ canMessage }: { canMessage: boolean }) {
  return (
    <Card>
      <EmptyState
        icon={<CalendarOff />}
        title="Online booking isn't available"
        description="Please contact your clinician to schedule an appointment."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {canMessage && (
              <LinkButton to="/client/messages" icon={<MessageSquare className="h-4 w-4" />}>
                Message your clinician
              </LinkButton>
            )}
            <LinkButton to="/client/appointments" variant="secondary">
              Back to appointments
            </LinkButton>
          </div>
        }
      />
    </Card>
  );
}

/** Client portal: request an appointment at an open time with a clinician on the care team (they
 * confirm it). */
export default function ClientBookingPage() {
  const client = usePortalClient();
  const options = useQuery({
    queryKey: bookingKeys.portalOptions,
    queryFn: portalBookingApi.options,
    enabled: client.permissions.booking,
  });
  const clinicians = options.data?.clinicians.filter((clinician) => clinician.services.length > 0) ?? [];

  const header = (
    <PageHeader
      title="Request an appointment"
      description="Pick a service and an open time. Your clinician will confirm by email."
      actions={
        <LinkButton to="/client/appointments" variant="ghost" icon={<ArrowLeft className="h-4 w-4" />}>
          Appointments
        </LinkButton>
      }
    />
  );

  let body: ReactNode;
  if (!client.permissions.booking || isForbidden(options.error)) {
    body = <BookingUnavailable canMessage={client.permissions.messaging} />;
  } else if (options.isPending) {
    body = <SectionSpinner />;
  } else if (options.isError) {
    body = (
      <Card>
        <ErrorState error={options.error} onRetry={() => void options.refetch()} />
      </Card>
    );
  } else if (clinicians.length === 0) {
    body = <BookingUnavailable canMessage={client.permissions.messaging} />;
  } else {
    body = (
      <BookingFlow
        clinicians={clinicians}
        locations={options.data.locations}
        timeZone={client.time_zone}
        canMessage={client.permissions.messaging}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      {header}
      {body}
    </div>
  );
}

function BookingFlow({
  clinicians,
  locations,
  timeZone,
  canMessage,
}: {
  /** Care-team clinicians with something to book, primary first. */
  clinicians: PortalBookingClinician[];
  locations: BookingLocation[];
  timeZone: string;
  canMessage: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const choosesClinician = clinicians.length > 1;
  const steps: Step[] = choosesClinician ? ['clinician', 'service', 'time', 'confirm'] : ['service', 'time', 'confirm'];
  const [step, setStep] = useState<Step>(steps[0]);
  const [clinician, setClinician] = useState<PortalBookingClinician | null>(choosesClinician ? null : clinicians[0]);
  const [service, setService] = useState<BookableService | null>(() =>
    clinician?.services.length === 1 ? clinician.services[0] : null,
  );
  const [slot, setSlot] = useState<Slot | null>(null);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const submit = useMutation({
    mutationFn: (input: PortalBookingInput) => portalBookingApi.request(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bookingKeys.portalAppointments });
      toast.success("Request sent. You'll get an email once it's confirmed.");
      navigate('/client/appointments');
    },
    onError: (error) => {
      if (!(error instanceof ApiError) || error.status !== 409) return;
      // Keep the taken slot so the picker reopens on its week; it drops out of the refetched list.
      setNotice(error.message);
      setStep('time');
      void queryClient.invalidateQueries({ queryKey: ['portal', 'booking', 'slots'] });
    },
  });

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const goTo = (next: Step) => {
    submit.reset();
    setStep(next);
  };

  const chooseClinician = (next: PortalBookingClinician) => {
    if (next.id !== clinician?.id) {
      setClinician(next);
      setService(next.services.length === 1 ? next.services[0] : null);
      setSlot(null);
      setNotice(null);
    }
    goTo('service');
  };

  const changeClinician = choosesClinician ? () => goTo('clinician') : undefined;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!clinician || !service || !slot) return;
    submit.mutate({
      clinician_id: clinician.id,
      service_id: service.id,
      starts_at: slot.starts_at,
      location_type: slot.location_type,
      message: message.trim(),
    });
  };

  if (submit.isError && isForbidden(submit.error)) return <BookingUnavailable canMessage={canMessage} />;
  const submitError = submit.isError && !(submit.error instanceof ApiError && submit.error.status === 409) ? submit.error : null;

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
            clinicians={clinicians}
            selectedId={clinician?.id ?? null}
            onSelect={chooseClinician}
            details={(item) =>
              item.services.map((option) => `${option.description} (${formatDuration(option.duration_minutes)})`).join(' · ')
            }
          />
        </>
      )}

      {step === 'service' && clinician && (
        <>
          <StepHeading
            headingRef={headingRef}
            title="Choose a service"
            description={`With ${clinician.name}`}
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
            description={`${service.description} with ${clinician.name}`}
            onBack={() => goTo('service')}
          />
          {notice && (
            <div className="mb-4">
              <Alert tone="warning">{notice}</Alert>
            </div>
          )}
          <SlotPicker
            source={PORTAL_SLOTS}
            clinicianId={clinician.id}
            serviceId={service.id}
            timeZone={timeZone}
            locations={locations}
            selected={slot}
            onSelect={(next) => {
              setSlot(next);
              setNotice(null);
              goTo('confirm');
            }}
          />
        </>
      )}

      {step === 'confirm' && clinician && service && slot && (
        <form onSubmit={handleSubmit}>
          <StepHeading headingRef={headingRef} title="Confirm your request" onBack={() => goTo('time')} />
          <BookingSummary
            clinicianName={clinician.name}
            service={service}
            slot={slot}
            timeZone={timeZone}
            locations={locations}
            onChangeClinician={changeClinician}
            onChangeService={() => goTo('service')}
            onChangeTime={() => goTo('time')}
          />
          <Field className="mt-5" label={`Message for ${clinician.name} (optional)`} hint={`${message.length}/${MESSAGE_LIMIT}`}>
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                maxLength={MESSAGE_LIMIT}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            )}
          </Field>
          <p className="mt-3 text-xs text-sage-500">
            Your time isn't reserved until {clinician.name} confirms it by email. For anything urgent, call or text 988
            (US) or your local emergency number.
          </p>
          {submitError && (
            <div className="mt-4">
              <Alert tone="danger">{submitError.message}</Alert>
            </div>
          )}
          <Button type="submit" loading={submit.isPending} className="mt-5 w-full sm:w-auto">
            Send request
          </Button>
        </form>
      )}
    </Card>
  );
}
