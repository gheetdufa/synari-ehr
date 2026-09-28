import type { PracticeSettings } from '../../api/practice';
import { useCan } from '../../auth/StaffAuth';
import { usePublicConfig } from '../../lib/usePublicConfig';
import { Alert } from '../../ui/Display';
import { Switch } from '../../ui/Form';
import { SettingsForm, usePracticeSettingsForm } from './SettingsForm';

const KEYS = ['waiting_room_enabled', 'recording_enabled'] as const;

/** Waiting room and consent-gated session recording for video appointments. */
export function TelehealthSettings({ settings }: { settings: PracticeSettings }) {
  const config = usePublicConfig();
  const canEdit = useCan('manage_practice');
  const form = usePracticeSettingsForm(settings, KEYS, 'Telehealth settings saved');
  const { draft, set } = form;

  return (
    <SettingsForm
      title="Telehealth"
      description="Video sessions run in the browser; clients join from their reminder or the portal without an account."
      dirty={form.dirty}
      saving={form.saving}
      readOnly={!canEdit}
      onSubmit={() => form.submit()}
      onDiscard={form.discard}
    >
      {!config.telehealth_enabled && (
        <Alert tone="warning" title="Telehealth isn't configured on this server">
          Video appointments can be scheduled, but sessions can&apos;t start until LiveKit is set up (LIVEKIT_URL,
          LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the API&apos;s environment).
        </Alert>
      )}
      <Switch
        label="Waiting room"
        description="Clients wait until their clinician admits them, and the clinician is notified when someone arrives. Turn off to let clients join the session directly."
        checked={draft.waiting_room_enabled}
        onChange={(checked) => set({ waiting_room_enabled: checked })}
      />
      <div className="space-y-3 border-t border-sage-100 pt-5">
        <Switch
          label="Allow session recording"
          description="Record session audio to transcribe it and draft a progress note."
          checked={draft.recording_enabled}
          onChange={(checked) => set({ recording_enabled: checked })}
        />
        <Alert tone={draft.recording_enabled ? 'info' : 'neutral'} title="How consent works">
          <ul className="list-disc space-y-1 pl-5">
            <li>Every client is asked for consent when they join, and can say no.</li>
            <li>
              Clinicians can only record when <strong>everyone admitted to the session</strong> has consented. If anyone
              declines, recording stays unavailable for that session.
            </li>
            <li>
              Audio is transcribed by the AI provider configured on this server and used to draft a note the clinician
              reviews and signs. Make sure your informed consent paperwork covers recording and AI transcription.
            </li>
          </ul>
        </Alert>
      </div>
    </SettingsForm>
  );
}
