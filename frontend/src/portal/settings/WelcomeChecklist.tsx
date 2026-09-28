import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Circle, X } from 'lucide-react';
import type { Session } from '../../api/auth';
import { availabilityApi, availabilityKeys, type AvailabilityBlock } from '../../api/availability';
import { practiceApi, practiceKeys, type PracticeSettings, type Service } from '../../api/practice';
import { useSession } from '../../auth/StaffAuth';
import { Card } from '../../ui/Card';
import type { SettingsTab } from './settingsTabs';

export interface ChecklistItem {
  tab: SettingsTab;
  title: string;
  description: string;
  done: boolean;
}

/** Setup steps for a new practice, each marked done from the current data. Clinician-only steps
 * are left out for owners who don't see clients. */
export function checklistItems(
  { staff, practice }: Session,
  settings: PracticeSettings | undefined,
  services: Service[] | undefined,
  availability: AvailabilityBlock[] | undefined,
): ChecklistItem[] {
  const steps: (ChecklistItem | false)[] = [
    staff.is_clinician && {
      tab: 'profile',
      title: 'Add your credentials',
      description: 'Credentials, license and NPI appear on superbills.',
      done: Boolean(staff.credentials && (staff.license_number || staff.npi)),
    },
    {
      tab: 'services',
      title: 'Set your services and rates',
      description: 'Starter CPT codes are ready; add your fees.',
      done: Boolean(services?.some((service) => service.is_active && service.rate_cents > 0)),
    },
    staff.is_clinician && {
      tab: 'availability',
      title: 'Choose your weekly hours',
      description: 'When clients can request appointments online.',
      done: Boolean(availability && availability.length > 0),
    },
    {
      tab: practice.booking_slug ? 'booking' : 'practice',
      title: 'Turn on your booking link',
      description: 'A public page where new clients can request a first visit.',
      done: Boolean(practice.booking_slug && settings?.booking_enabled),
    },
    {
      tab: 'notifications',
      title: 'Review appointment reminders',
      description: 'Email and text reminders cut down on no-shows.',
      done: Boolean(settings && (settings.reminder_email_enabled || settings.reminder_sms_enabled)),
    },
  ];
  return steps.filter((step): step is ChecklistItem => step !== false);
}

/** Welcome card for new practices (shown with ?welcome=1). */
export function WelcomeChecklist({
  settings,
  onSelectTab,
  onDismiss,
}: {
  settings: PracticeSettings | undefined;
  onSelectTab: (tab: SettingsTab) => void;
  onDismiss: () => void;
}) {
  const session = useSession();
  const services = useQuery({ queryKey: practiceKeys.services, queryFn: practiceApi.services });
  const availability = useQuery({
    queryKey: availabilityKeys.clinician(session.staff.id),
    queryFn: () => availabilityApi.get(session.staff.id),
    enabled: session.staff.is_clinician,
  });
  const items = checklistItems(session, settings, services.data, availability.data);
  const completed = items.filter((item) => item.done).length;

  return (
    <Card className="mb-6 overflow-hidden border-primary-100">
      <div className="flex items-start justify-between gap-4 bg-gradient-to-r from-primary-50 to-white px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-sage-900">Welcome, {session.staff.first_name}! Let&apos;s set up your practice.</h2>
          <p className="mt-0.5 text-sm text-sage-600">
            {completed} of {items.length} done. You can come back to any of these later.
          </p>
          <div
            className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-sage-100"
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={completed}
          >
            <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${(completed / items.length) * 100}%` }} />
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Hide setup checklist"
          className="rounded-lg p-1 text-sage-500 hover:bg-sage-100 hover:text-sage-800"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <ul className="divide-y divide-sage-100">
        {items.map((item) => (
          <li key={item.tab}>
            <button
              type="button"
              onClick={() => onSelectTab(item.tab)}
              className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-sage-50 focus:outline-none focus-visible:bg-sage-50"
            >
              {item.done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-sage-300" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-medium ${item.done ? 'text-sage-500' : 'text-sage-900'}`}>
                  {item.title}
                  <span className="sr-only">{item.done ? ' (done)' : ' (to do)'}</span>
                </span>
                <span className="block text-xs text-sage-500">{item.description}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
