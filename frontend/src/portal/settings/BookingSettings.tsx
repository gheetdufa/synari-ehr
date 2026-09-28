import { Link } from 'react-router-dom';
import { Copy, ExternalLink } from 'lucide-react';
import type { PracticeSettings } from '../../api/practice';
import { useCan, useSession } from '../../auth/StaffAuth';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, Badge } from '../../ui/Display';
import { Field, Select, Switch, Textarea } from '../../ui/Form';
import { useToast } from '../../ui/Toast';
import { bookingUrl, hoursLabel, numberOptions } from './settingsHelpers';
import { SettingsForm, usePracticeSettingsForm } from './SettingsForm';

const KEYS = [
  'cancellation_window_hours',
  'booking_enabled',
  'booking_accepts_new_clients',
  'booking_min_notice_hours',
  'booking_max_days_ahead',
  'booking_slot_interval_minutes',
  'booking_intro',
] as const;

const SLOT_LABELS: Record<number, string> = {
  0: 'Match the service length',
  15: 'Every 15 minutes',
  30: 'Every 30 minutes',
  60: 'On the hour',
};

/** The practice's public booking page: its link, and whether new clients can reach it. */
function BookingPageCard({ settings }: { settings: PracticeSettings }) {
  const { practice } = useSession();
  const toast = useToast();
  const slug = practice.booking_slug;
  const live = Boolean(slug) && settings.booking_enabled && settings.booking_accepts_new_clients;
  const url = slug ? bookingUrl(window.location.origin, slug) : '';
  const copy = () =>
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success('Booking link copied'))
      .catch(() => toast.error("Couldn't copy the link. Select it and copy it manually."));

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Booking page {live ? <Badge tone="success">Live</Badge> : <Badge>Hidden</Badge>}
          </span>
        }
        description="A public page where new clients request a first appointment with the practice."
      />
      <CardBody className="space-y-3">
        {slug ? (
          <>
            <p className="break-all text-sm text-sage-800">{url}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" icon={<Copy className="h-4 w-4" />} onClick={() => void copy()}>
                Copy link
              </Button>
              {live && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
                >
                  Open booking page <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
            </div>
            {!live && (
              <p className="text-xs text-sage-500">
                The page is only visible while online requests are on and the practice is accepting new clients.
              </p>
            )}
          </>
        ) : (
          <Alert tone="info">
            The practice doesn&apos;t have a booking link yet.{' '}
            <Link to="?tab=practice" className="font-medium underline">
              Choose one in Practice settings
            </Link>
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}

/** Practice-wide cancellation policy and online booking rules, with the booking page link. */
export function BookingSettings({ settings }: { settings: PracticeSettings }) {
  const canEdit = useCan('manage_practice');
  const form = usePracticeSettingsForm(settings, KEYS, 'Scheduling and booking settings saved');
  const { draft, set, errors } = form;

  return (
    <div className="space-y-6">
      <BookingPageCard settings={settings} />
      <SettingsForm
        title="Scheduling & booking"
        description="The practice's cancellation policy and how clients request appointments online."
        dirty={form.dirty}
        saving={form.saving}
        readOnly={!canEdit}
        onSubmit={() => form.submit()}
        onDiscard={form.discard}
      >
        <Field
          label="Client cancellations"
          hint="Clients can cancel in the portal up to this long before an appointment. Inside the window they need to contact the practice."
          error={errors.cancellation_window_hours}
        >
          {(props) => (
            <Select
              {...props}
              value={draft.cancellation_window_hours}
              onChange={(e) => set({ cancellation_window_hours: Number(e.target.value) })}
            >
              {numberOptions([0, 24, 48, 72], settings.cancellation_window_hours).map((hours) => (
                <option key={hours} value={hours}>
                  {hours === 0 ? 'Clients must contact the practice to cancel' : `Up to ${hoursLabel(hours)} before`}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="space-y-4 border-t border-sage-100 pt-5">
          <Switch
            label="Online appointment requests"
            description="Existing clients can request times from the portal. Every request waits for the practice to accept or decline."
            checked={draft.booking_enabled}
            onChange={(checked) => set({ booking_enabled: checked })}
          />
          <Switch
            label="Accepting new clients"
            description="New clients can request a first appointment from the booking page, with clinicians who are accepting new clients."
            checked={draft.booking_accepts_new_clients}
            disabled={!draft.booking_enabled}
            onChange={(checked) => set({ booking_accepts_new_clients: checked })}
          />
        </div>

        <div className="grid gap-4 border-t border-sage-100 pt-5 sm:grid-cols-3">
          <Field label="Minimum notice" error={errors.booking_min_notice_hours}>
            {(props) => (
              <Select
                {...props}
                value={draft.booking_min_notice_hours}
                disabled={!draft.booking_enabled}
                onChange={(e) => set({ booking_min_notice_hours: Number(e.target.value) })}
              >
                {numberOptions([0, 1, 2, 4, 12, 24, 48, 72], settings.booking_min_notice_hours).map((hours) => (
                  <option key={hours} value={hours}>
                    {hours === 0 ? 'No minimum' : hoursLabel(hours)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Book up to" error={errors.booking_max_days_ahead}>
            {(props) => (
              <Select
                {...props}
                value={draft.booking_max_days_ahead}
                disabled={!draft.booking_enabled}
                onChange={(e) => set({ booking_max_days_ahead: Number(e.target.value) })}
              >
                {numberOptions([7, 14, 30, 60, 90, 180, 365], settings.booking_max_days_ahead).map((days) => (
                  <option key={days} value={days}>
                    {days} days ahead
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Start times" error={errors.booking_slot_interval_minutes}>
            {(props) => (
              <Select
                {...props}
                value={draft.booking_slot_interval_minutes}
                disabled={!draft.booking_enabled}
                onChange={(e) => set({ booking_slot_interval_minutes: Number(e.target.value) })}
              >
                {numberOptions([0, 15, 30, 60], settings.booking_slot_interval_minutes).map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {SLOT_LABELS[minutes] ?? `Every ${minutes} minutes`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Field
          label="Booking page introduction"
          hint="Shown at the top of the booking page. Keep it general; don't include client information."
          error={errors.booking_intro}
        >
          {(props) => (
            <Textarea
              {...props}
              rows={4}
              maxLength={20000}
              value={draft.booking_intro}
              onChange={(e) => set({ booking_intro: e.target.value })}
            />
          )}
        </Field>

        {!draft.booking_enabled && (
          <Alert tone="neutral">
            Online requests are off. Clients won&apos;t see open times in the portal and the booking page is hidden.
          </Alert>
        )}
      </SettingsForm>
    </div>
  );
}
