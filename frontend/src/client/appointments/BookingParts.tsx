import type { ComponentType, ReactNode, RefObject } from 'react';
import { ArrowLeft, Check, ChevronRight, Clock, MapPin, Phone, Video } from 'lucide-react';
import { LOCATION_LABELS, type LocationType } from '../../api/appointments';
import type { BookableService, BookingClinician, BookingLocation, PricedService, Slot } from '../../api/booking';
import { formatMoney } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Avatar } from '../../ui/Display';
import { formatDuration, formatLongDay, formatTimeSpan, timeZoneName } from './slots';

const LOCATION_ICONS: Record<LocationType, ComponentType<{ className?: string }>> = {
  video: Video,
  in_person: MapPin,
  phone: Phone,
};

/** Icon for a location type, sized by the caller. */
export function LocationIcon({ type, className = 'h-4 w-4' }: { type: LocationType; className?: string }) {
  const Icon = LOCATION_ICONS[type];
  return <Icon className={className} aria-hidden="true" />;
}

/** "JL" from "Jordan Lee, LCSW". */
export function nameInitials(name: string): string {
  const words = name.split(',')[0].trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}

/** "Video", "Phone", "In person", or "In person · Main office" when the slot names an office. */
export function slotLocationText(slot: Pick<Slot, 'location_type' | 'location_id'>, locations: BookingLocation[] = []): string {
  const office = slot.location_type === 'in_person' ? locations.find((location) => location.id === slot.location_id) : undefined;
  return office ? `${LOCATION_LABELS.in_person} · ${office.name}` : LOCATION_LABELS[slot.location_type];
}

/** Where a slot happens, with its icon: the office's name for in-person slots when known. */
export function LocationLabel({
  slot,
  locations,
  className = '',
}: {
  slot: Pick<Slot, 'location_type' | 'location_id'>;
  locations?: BookingLocation[];
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <LocationIcon type={slot.location_type} className="h-3.5 w-3.5 shrink-0" />
      {slotLocationText(slot, locations)}
    </span>
  );
}

/** Numbered progress for a multi-step booking flow; finished steps can be revisited. */
export function BookingSteps({
  steps,
  current,
  onStepSelect,
}: {
  steps: string[];
  current: number;
  onStepSelect: (index: number) => void;
}) {
  return (
    <nav aria-label="Booking progress" className="mb-5">
      <ol className="flex items-center gap-2">
        {steps.map((label, index) => {
          const done = index < current;
          const active = index === current;
          const marker = (
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                done
                  ? 'bg-primary-600 text-white'
                  : active
                    ? 'bg-primary-50 text-primary-800 ring-2 ring-primary-600'
                    : 'bg-white text-sage-500 ring-1 ring-sage-200'
              }`}
            >
              {done ? <Check className="h-4 w-4" aria-hidden="true" /> : index + 1}
            </span>
          );
          const text = (
            <span
              className={`text-sm font-medium ${active ? 'text-sage-900' : done ? 'text-primary-800' : 'text-sage-500'} ${
                active ? '' : 'hidden sm:inline'
              }`}
            >
              {label}
            </span>
          );
          return (
            <li key={label} className="flex min-w-0 items-center gap-2" aria-current={active ? 'step' : undefined}>
              {done ? (
                <button
                  type="button"
                  onClick={() => onStepSelect(index)}
                  className="flex items-center gap-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
                  aria-label={`Back to ${label.toLowerCase()} (done)`}
                >
                  {marker}
                  {text}
                </button>
              ) : (
                <>
                  {marker}
                  {text}
                </>
              )}
              {index < steps.length - 1 && <span aria-hidden="true" className="h-px w-4 shrink-0 bg-sage-200 sm:w-8" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Title of the current booking step. The heading takes focus when the step changes, so
 * screen-reader users hear where they are.
 */
export function StepHeading({
  title,
  description,
  onBack,
  headingRef,
}: {
  title: string;
  description?: ReactNode;
  onBack?: () => void;
  headingRef: RefObject<HTMLHeadingElement>;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-sage-900 focus:outline-none">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-sage-600">{description}</p>}
      </div>
      {onBack && (
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack}>
          Back
        </Button>
      )}
    </div>
  );
}

/** Pick who to book with: one card per clinician, with `details` (e.g. services) underneath. */
export function ClinicianPicker<T extends BookingClinician>({
  clinicians,
  selectedId,
  onSelect,
  details,
}: {
  clinicians: T[];
  selectedId: number | null;
  onSelect: (clinician: T) => void;
  details?: (clinician: T) => ReactNode;
}) {
  return (
    <ul className="space-y-2" aria-label="Clinicians">
      {clinicians.map((clinician) => {
        const selected = clinician.id === selectedId;
        return (
          <li key={clinician.id}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(clinician)}
              className={`group flex w-full items-center gap-4 rounded-xl border bg-white px-4 py-3.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                selected ? 'border-primary-500 ring-1 ring-primary-500' : 'border-sage-200 hover:border-primary-300 hover:bg-primary-50/40'
              }`}
            >
              <Avatar label={nameInitials(clinician.name)} className="h-11 w-11 text-sm" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-sage-900">{clinician.name}</span>
                {details && <span className="mt-0.5 block text-sm text-sage-600">{details(clinician)}</span>}
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-sage-400 transition-colors group-hover:text-primary-600" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function isPriced(service: BookableService | PricedService): service is PricedService {
  return 'rate_cents' in service;
}

/** Pick one service: its description and length, and its fee on the public page (portal clients
 * never see rates). */
export function ServicePicker<T extends BookableService | PricedService>({
  services,
  selectedId,
  onSelect,
}: {
  services: T[];
  selectedId: number | null;
  onSelect: (service: T) => void;
}) {
  return (
    <ul className="space-y-2" aria-label="Services">
      {services.map((service) => {
        const selected = service.id === selectedId;
        return (
          <li key={service.id}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(service)}
              className={`group flex w-full items-center gap-4 rounded-xl border bg-white px-4 py-3.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                selected ? 'border-primary-500 ring-1 ring-primary-500' : 'border-sage-200 hover:border-primary-300 hover:bg-primary-50/40'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-sage-900">{service.description}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-sm text-sage-600">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  {formatDuration(service.duration_minutes)}
                  {isPriced(service) && <span className="text-sage-500">· {formatMoney(service.rate_cents)}</span>}
                </span>
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-sage-400 transition-colors group-hover:text-primary-600" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SummaryRow({ label, children, onChange }: { label: string; children: ReactNode; onChange?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <dt className="text-xs font-medium uppercase tracking-wide text-sage-500">{label}</dt>
        <dd className="mt-0.5 text-sm text-sage-900">{children}</dd>
      </div>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          className="shrink-0 rounded text-sm font-medium text-primary-700 hover:text-primary-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          aria-label={`Change ${label.toLowerCase()}`}
        >
          Change
        </button>
      )}
    </div>
  );
}

/** What is being requested: clinician, service, day and time (in `timeZone`) and location. */
export function BookingSummary({
  clinicianName,
  service,
  slot,
  timeZone,
  locations,
  onChangeClinician,
  onChangeService,
  onChangeTime,
}: {
  clinicianName: string;
  service: BookableService;
  slot: Slot;
  timeZone: string;
  locations?: BookingLocation[];
  onChangeClinician?: () => void;
  onChangeService?: () => void;
  onChangeTime?: () => void;
}) {
  return (
    <dl className="divide-y divide-sage-100 rounded-xl border border-sage-100 bg-sage-50/60 px-4">
      <SummaryRow label="Clinician" onChange={onChangeClinician}>
        {clinicianName}
      </SummaryRow>
      <SummaryRow label="Service" onChange={onChangeService}>
        {service.description}
        <span className="text-sage-500"> · {formatDuration(service.duration_minutes)}</span>
      </SummaryRow>
      <SummaryRow label="Time" onChange={onChangeTime}>
        <span className="block font-medium">{formatLongDay(slot.starts_at, timeZone)}</span>
        <span className="block">
          {formatTimeSpan(slot.starts_at, slot.ends_at, timeZone)}{' '}
          <span className="text-sage-500">({timeZoneName(timeZone, new Date(slot.starts_at))})</span>
        </span>
      </SummaryRow>
      <SummaryRow label="Location">
        <LocationLabel slot={slot} locations={locations} />
      </SummaryRow>
    </dl>
  );
}
