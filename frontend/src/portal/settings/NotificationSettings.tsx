import type { StaffPreferences } from '../../api/me';
import type { PracticeSettings } from '../../api/practice';
import { useCan } from '../../auth/StaffAuth';
import { usePublicConfig } from '../../lib/usePublicConfig';
import { Alert } from '../../ui/Display';
import { Field, Select, Switch } from '../../ui/Form';
import { hoursLabel, numberOptions } from './settingsHelpers';
import { SettingsForm, usePracticeSettingsForm, usePreferencesForm } from './SettingsForm';

const REMINDER_KEYS = ['reminder_email_enabled', 'reminder_email_hours', 'reminder_sms_enabled', 'reminder_sms_hours'] as const;
const NOTIFY_KEYS = ['notify_email_messages', 'notify_email_requests', 'notify_email_forms'] as const;

/** Practice-wide appointment reminders sent to clients. */
function ClientReminders({ settings }: { settings: PracticeSettings }) {
  const config = usePublicConfig();
  const canEdit = useCan('manage_practice');
  const form = usePracticeSettingsForm(settings, REMINDER_KEYS, 'Reminder settings saved');
  const { draft, set, errors } = form;

  return (
    <SettingsForm
      title="Client appointment reminders"
      description="For everyone in the practice. Reminders never include clinical details, only the time, place and practice name."
      dirty={form.dirty}
      saving={form.saving}
      readOnly={!canEdit}
      onSubmit={() => form.submit()}
      onDiscard={form.discard}
    >
      {!config.email_enabled && (
        <Alert tone="warning" title="Email isn't configured on this server">
          Reminders and notices are queued but won&apos;t be delivered until an email provider is set up.
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-[1fr_14rem] sm:items-start">
        <Switch
          label="Email reminders"
          description="Sent to clients who have email reminders on. Video appointments include the join link."
          checked={draft.reminder_email_enabled}
          onChange={(checked) => set({ reminder_email_enabled: checked })}
        />
        <Field label="Send" error={errors.reminder_email_hours}>
          {(props) => (
            <Select
              {...props}
              value={draft.reminder_email_hours}
              disabled={!draft.reminder_email_enabled}
              onChange={(e) => set({ reminder_email_hours: Number(e.target.value) })}
            >
              {numberOptions([24, 36, 48, 72], settings.reminder_email_hours).map((hours) => (
                <option key={hours} value={hours}>
                  {hoursLabel(hours)} before
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_14rem] sm:items-start">
        <Switch
          label="Text message reminders"
          description={
            config.sms_enabled
              ? 'Sent only to clients who agreed to texts. Clients can reply STOP to opt out.'
              : "Text messaging isn't configured on this server. Add Twilio credentials to the API's environment to turn it on."
          }
          checked={config.sms_enabled && draft.reminder_sms_enabled}
          disabled={!config.sms_enabled}
          onChange={(checked) => set({ reminder_sms_enabled: checked })}
        />
        <Field label="Send" error={errors.reminder_sms_hours}>
          {(props) => (
            <Select
              {...props}
              value={draft.reminder_sms_hours}
              disabled={!config.sms_enabled || !draft.reminder_sms_enabled}
              onChange={(e) => set({ reminder_sms_hours: Number(e.target.value) })}
            >
              {numberOptions([24, 48, 72], settings.reminder_sms_hours).map((hours) => (
                <option key={hours} value={hours}>
                  {hoursLabel(hours)} before
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </SettingsForm>
  );
}

/** Which events email the signed-in person (their own choice). */
function EmailNotifications({ preferences }: { preferences: StaffPreferences }) {
  const form = usePreferencesForm(preferences, NOTIFY_KEYS, 'Notification preferences saved');
  const { draft, set } = form;

  return (
    <SettingsForm
      title="Email me when"
      description="Just for you. You always get in-app notifications, and emails never contain client details."
      dirty={form.dirty}
      saving={form.saving}
      onSubmit={() => form.submit()}
      onDiscard={form.discard}
    >
      <Switch
        label="A client sends me a message"
        checked={draft.notify_email_messages}
        onChange={(checked) => set({ notify_email_messages: checked })}
      />
      <Switch
        label="Someone requests an appointment"
        checked={draft.notify_email_requests}
        onChange={(checked) => set({ notify_email_requests: checked })}
      />
      <Switch
        label="A client completes a form"
        description="Flagged answers (for example on a PHQ-9) are always highlighted in-app."
        checked={draft.notify_email_forms}
        onChange={(checked) => set({ notify_email_forms: checked })}
      />
    </SettingsForm>
  );
}

/** Client reminders (practice-wide) and the signed-in person's own email notifications. */
export function NotificationSettings({
  settings,
  preferences,
}: {
  settings: PracticeSettings;
  preferences: StaffPreferences;
}) {
  return (
    <div className="space-y-6">
      <ClientReminders settings={settings} />
      <EmailNotifications preferences={preferences} />
    </div>
  );
}
