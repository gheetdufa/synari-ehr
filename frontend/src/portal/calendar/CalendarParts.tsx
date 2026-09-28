/** Small building blocks shared by the calendar's dialogs and views. */
import { useId, type ReactNode } from 'react';
import { MapPin, Phone, Video } from 'lucide-react';
import {
  LOCATION_LABELS,
  type Appointment,
  type ConflictDetail,
  type EditScope,
  type LocationRef,
  type LocationType,
} from '../../api/appointments';
import { formatDate } from '../../lib/format';
import { Alert, Badge } from '../../ui/Display';
import { entryTitle, statusLabel, statusTone } from './appointmentStyles';
import { formatTimeRange } from './calendarMath';

export function LocationIcon({ type, className = 'h-4 w-4' }: { type: LocationType; className?: string }) {
  if (type === 'video') return <Video className={className} aria-hidden="true" />;
  if (type === 'phone') return <Phone className={className} aria-hidden="true" />;
  return <MapPin className={className} aria-hidden="true" />;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** A row of mutually exclusive options (radio semantics), styled as a segmented control. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className = '',
}: {
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex rounded-lg border border-sage-200 bg-sage-50 p-0.5 ${className}`}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label
            key={option.value}
            className={`relative flex flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-400 ${
              checked ? 'bg-white text-primary-800 shadow-sm' : 'text-sage-600 hover:text-sage-900'
            } ${option.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

/** "This appointment" vs "This and following" for recurring series. */
export function ScopeChoice({
  value,
  onChange,
  action,
}: {
  value: EditScope;
  onChange: (scope: EditScope) => void;
  action: string;
}) {
  const name = useId();
  const options: { value: EditScope; label: string; description: string }[] = [
    { value: 'this', label: 'This appointment', description: 'Only this occurrence' },
    { value: 'following', label: 'This and following', description: 'This and every later occurrence in the series' },
  ];
  return (
    <fieldset className="rounded-lg border border-sage-200 p-3">
      <legend className="px-1 text-sm font-medium text-sage-800">{action} which appointments?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
              value === option.value ? 'border-primary-400 bg-primary-50' : 'border-sage-200 hover:bg-sage-50'
            }`}
          >
            <input
              type="radio"
              name={name}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="mt-0.5 h-4 w-4 border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
            />
            <span>
              <span className="block font-medium text-sage-900">{option.label}</span>
              <span className="block text-xs text-sage-500">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ConflictItems({ label, items, timeZone }: { label: string; items: Appointment[]; timeZone: string }) {
  return (
    <div className="mt-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">{label}</p>
      <ul className="mt-1 space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium">{entryTitle(item)}</span>
            <span className="text-amber-800">
              {formatDate(item.starts_at, timeZone, { weekday: 'short', year: undefined })} ·{' '}
              {formatTimeRange(item.starts_at, item.ends_at, timeZone)} · {item.clinician.name}
            </span>
            {item.status === 'requested' && <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What a proposed time overlaps, from a 409: the clinician's own calendar entries, and other
 * appointments the clients already have then.
 */
export function ConflictList({
  detail,
  timeZone,
  footer,
}: {
  detail: ConflictDetail;
  timeZone: string;
  footer?: ReactNode;
}) {
  return (
    <Alert tone="warning" title={detail.message}>
      {detail.conflicts.length > 0 && (
        <ConflictItems label="On the clinician's calendar" items={detail.conflicts} timeZone={timeZone} />
      )}
      {detail.client_conflicts.length > 0 && (
        <ConflictItems label="Clients already booked then" items={detail.client_conflicts} timeZone={timeZone} />
      )}
      {footer && <div className="mt-2">{footer}</div>}
    </Alert>
  );
}

/** "In person · Main office · Suite 204": how it happens, the office, and any details. */
export function locationText(type: LocationType, details: string, office: LocationRef | null = null): string {
  return [LOCATION_LABELS[type], office?.name ?? '', details].filter(Boolean).join(' · ');
}
