import { WifiOff } from 'lucide-react';
import type { JoinInfo } from '../../api/telehealth';
import { DevicePreview } from '../../telehealth/video/DevicePreview';
import type { LocalPreview } from '../../telehealth/video/useLocalPreview';
import { Button } from '../../ui/Button';
import { formatAppointmentTime } from './JoinLayout';

/** The calm screen a guest sees until the clinician admits them. The camera check stays live. */
export function WaitingScreen({
  info,
  preview,
  connectionTrouble,
  onLeave,
}: {
  info: JoinInfo;
  preview: LocalPreview;
  connectionTrouble: boolean;
  onLeave: () => void;
}) {
  return (
    <div className="mx-auto grid max-w-4xl items-center gap-6 pt-2 sm:pt-8 lg:grid-cols-2 lg:gap-10">
      <div className="text-center lg:text-left" role="status" aria-live="polite">
        <div className="relative mx-auto mb-5 flex h-14 w-14 items-center justify-center lg:mx-0" aria-hidden="true">
          <span className="absolute h-14 w-14 animate-ping rounded-full bg-primary-200 opacity-60 [animation-duration:2.4s]" />
          <span className="relative h-5 w-5 rounded-full bg-primary-500" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-sage-900 sm:text-3xl">You&apos;re in the waiting room</h1>
        <p className="mt-3 text-base text-sage-700">{info.clinician_name} will let you in shortly.</p>
        <p className="mt-1 text-sm text-sage-500">Your appointment: {formatAppointmentTime(info.starts_at, info.time_zone)}</p>
        <p className="mt-4 text-sm text-sage-500">Keep this page open. You&apos;ll join automatically when you&apos;re admitted.</p>
        {connectionTrouble && (
          <p className="mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <WifiOff className="h-4 w-4 shrink-0" /> Having trouble reaching the server. Still trying…
          </p>
        )}
        <div className="mt-6">
          <Button variant="ghost" onClick={onLeave}>
            Leave waiting room
          </Button>
        </div>
      </div>
      <div className="mx-auto w-full max-w-md">
        <DevicePreview preview={preview} compact />
      </div>
    </div>
  );
}
