import type { ReactNode } from 'react';
import { CalendarClock } from 'lucide-react';
import type { JoinInfo } from '../../api/telehealth';
import { Brand } from '../../components/BrandMark';
import '../../components/brand-mark.css';

/**
 * "Monday, October 5 at 10:00 AM EDT" in the appointment's time zone for this client (theirs, or
 * their clinician's). The zone name is shown so a guest who is travelling isn't confused.
 */
export function formatAppointmentTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

/** Calm, light page frame for the guest join flow (everything but the call itself). */
export function JoinLayout({ info, children }: { info?: JoinInfo; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-gradient-to-b from-primary-50 via-white to-sage-50">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <span className="min-w-0 truncate text-sm font-semibold text-sage-900">{info?.practice_name || ''}</span>
        <span className="shrink-0 opacity-80 [&_.stack-mark]:w-5" title="Secure video by Synari">
          <Brand wordClassName="text-sm font-medium text-sage-600" />
        </span>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">{children}</main>
    </div>
  );
}

export function AppointmentSummary({ info }: { info: JoinInfo }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-sage-900 sm:text-3xl">
        Video appointment with {info.clinician_name}
      </h1>
      <p className="mt-2 flex items-center gap-2 text-sm text-sage-600">
        <CalendarClock className="h-4 w-4 shrink-0" />
        {formatAppointmentTime(info.starts_at, info.time_zone)}
      </p>
    </div>
  );
}

/** A centered message card for the states where there's nothing to join. */
export function JoinMessage({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto mt-6 max-w-lg rounded-2xl border border-sage-100 bg-white p-6 text-center shadow-sm sm:mt-12 sm:p-8">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-primary-700 [&>svg]:h-6 [&>svg]:w-6">
        {icon}
      </div>
      <h1 className="text-xl font-semibold text-sage-900">{title}</h1>
      {children && <div className="mt-2 space-y-2 text-sm text-sage-600">{children}</div>}
      {action && <div className="mt-6 flex flex-col items-center gap-2">{action}</div>}
    </div>
  );
}
