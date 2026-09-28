import { useState, type FormEvent } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import type { EnterInput, JoinInfo } from '../../api/telehealth';
import { DevicePreview } from '../../telehealth/video/DevicePreview';
import type { LocalPreview } from '../../telehealth/video/useLocalPreview';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox, Field, Input } from '../../ui/Form';
import { AppointmentSummary } from './JoinLayout';

/** Check-in form for a video appointment, next to a camera and microphone check. */
export function JoinForm({
  info,
  preview,
  defaults,
  submitting,
  error,
  onSubmit,
}: {
  info: JoinInfo;
  preview: LocalPreview;
  defaults: EnterInput | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: EnterInput) => void;
}) {
  const [name, setName] = useState(defaults?.display_name ?? '');
  const [location, setLocation] = useState(defaults?.current_location ?? '');
  const [consent, setConsent] = useState(defaults?.recording_consent ?? false);
  const [nameError, setNameError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const displayName = name.trim();
    if (!displayName) {
      setNameError('Please enter your name.');
      return;
    }
    setNameError(null);
    onSubmit({
      display_name: displayName,
      current_location: location.trim(),
      recording_consent: info.recording_enabled && consent,
    });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-10">
      <div className="lg:col-start-2 lg:row-start-1">
        <AppointmentSummary info={info} />
      </div>
      <section aria-label="Camera and microphone check" className="lg:col-start-1 lg:row-span-2 lg:row-start-1">
        <DevicePreview preview={preview} />
      </section>
      <div className="lg:col-start-2 lg:row-start-2">
        <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border border-sage-100 bg-white p-5 shadow-sm">
          <Field label="Your name" required error={nameError} hint="This is how you'll appear in the session.">
            {(props) => (
              <Input
                {...props}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                autoComplete="name"
                required
              />
            )}
          </Field>
          <Field
            label="Where are you right now? (optional)"
            hint="Only used if there's an emergency during your session, so help can be sent to you. For example, a street address or the name of the place you are."
          >
            {(props) => (
              <Input {...props} value={location} onChange={(event) => setLocation(event.target.value)} maxLength={300} />
            )}
          </Field>
          {info.recording_enabled && (
            <div className="rounded-lg bg-sage-50 p-3">
              <Checkbox
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                label="I agree to this session's audio being recorded"
                description={`${info.clinician_name} uses a recording of the session's audio to help write their notes. It is deleted once the note is signed. Saying no is completely fine and won't change your session.`}
              />
            </div>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" className="h-12 w-full text-base" loading={submitting} icon={<LogIn className="h-5 w-5" />}>
            {info.waiting_room_enabled ? 'Enter waiting room' : 'Join session'}
          </Button>
          <p className="flex items-start gap-2 text-xs text-sage-500">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            Your video is private and encrypted. No account is needed. For the best sound, use headphones.
          </p>
        </form>
      </div>
    </div>
  );
}
