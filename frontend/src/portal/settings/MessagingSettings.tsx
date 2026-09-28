import type { StaffPreferences } from '../../api/me';
import type { PracticeSettings } from '../../api/practice';
import { useCan, useSession } from '../../auth/StaffAuth';
import { Field, Switch, Textarea } from '../../ui/Form';
import { SettingsForm, usePracticeSettingsForm, usePreferencesForm } from './SettingsForm';

const PRACTICE_KEYS = ['messaging_enabled'] as const;
const AWAY_KEYS = ['away_message_enabled', 'away_message'] as const;
export const AWAY_MESSAGE_LIMIT = 600;

type AwayDraft = Pick<StaffPreferences, (typeof AWAY_KEYS)[number]>;

export function validateAwayMessage(draft: AwayDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.away_message.length > AWAY_MESSAGE_LIMIT) {
    errors.away_message = `Keep it under ${AWAY_MESSAGE_LIMIT} characters`;
  }
  if (draft.away_message_enabled && !draft.away_message.trim()) {
    errors.away_message = 'Write the message clients will see while you are away';
  }
  return errors;
}

/** Practice-wide switch for secure messaging in the client portal. */
function PracticeMessaging({ settings }: { settings: PracticeSettings }) {
  const canEdit = useCan('manage_practice');
  const form = usePracticeSettingsForm(settings, PRACTICE_KEYS, 'Messaging settings saved');

  return (
    <SettingsForm
      title="Secure messaging"
      description="Secure messages between clients and their clinicians in the client portal."
      dirty={form.dirty}
      saving={form.saving}
      readOnly={!canEdit}
      onSubmit={() => form.submit()}
      onDiscard={form.discard}
    >
      <Switch
        label="Secure messaging"
        description="Clients with messaging turned on in their chart can message their clinician from the portal. Their email notice never contains the message."
        checked={form.draft.messaging_enabled}
        onChange={(checked) => form.set({ messaging_enabled: checked })}
      />
    </SettingsForm>
  );
}

/** The signed-in clinician's own away message. */
function AwayMessage({ preferences, messagingEnabled }: { preferences: StaffPreferences; messagingEnabled: boolean }) {
  const form = usePreferencesForm(preferences, AWAY_KEYS, 'Away message saved');
  const { draft, set, errors } = form;
  const remaining = AWAY_MESSAGE_LIMIT - draft.away_message.length;

  return (
    <SettingsForm
      title="Your away message"
      description="Shown to your clients in the portal while it's on. Messages are still delivered."
      dirty={form.dirty}
      saving={form.saving}
      onSubmit={() => form.submit(validateAwayMessage)}
      onDiscard={form.discard}
    >
      <Switch
        label="Away message"
        description={messagingEnabled ? undefined : 'Secure messaging is off for the practice.'}
        checked={draft.away_message_enabled}
        disabled={!messagingEnabled}
        onChange={(checked) => set({ away_message_enabled: checked })}
      />
      <Field
        label="Away message text"
        error={errors.away_message}
        hint={
          <span className={remaining < 0 ? 'text-red-600' : remaining < 60 ? 'text-amber-700' : undefined} aria-live="polite">
            {remaining >= 0 ? `${remaining} characters left` : `${-remaining} characters over the limit`}
          </span>
        }
      >
        {(props) => (
          <Textarea
            {...props}
            rows={4}
            value={draft.away_message}
            disabled={!messagingEnabled}
            placeholder="I'm out of the office until Monday and will reply when I'm back. If this is an emergency, call 988 or 911."
            onChange={(e) => set({ away_message: e.target.value })}
          />
        )}
      </Field>
    </SettingsForm>
  );
}

/** Messaging on/off for the practice, and (for clinicians) their own away message. */
export function MessagingSettings({
  settings,
  preferences,
}: {
  settings: PracticeSettings;
  preferences: StaffPreferences;
}) {
  const { staff } = useSession();
  return (
    <div className="space-y-6">
      <PracticeMessaging settings={settings} />
      {staff.is_clinician && <AwayMessage preferences={preferences} messagingEnabled={settings.messaging_enabled} />}
    </div>
  );
}
