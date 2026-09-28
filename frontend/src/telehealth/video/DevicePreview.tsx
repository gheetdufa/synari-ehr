import { useEffect, useId, useRef, type ReactNode } from 'react';
import { facingModeFromLocalTrack } from 'livekit-client';
import { Mic, MicOff, RefreshCw, Video, VideoOff } from 'lucide-react';
import { Spinner } from '../../ui/Spinner';
import { mediaProblemHelp, type MediaDeviceKindName, type MediaProblem } from './mediaErrors';
import { useAudioLevel, useDeviceList, type LocalPreview } from './useLocalPreview';

function DeviceSelect({
  kind,
  label,
  value,
  refreshKey,
  disabled,
  onChange,
}: {
  kind: 'audioinput' | 'videoinput';
  label: string;
  value: string;
  refreshKey: unknown;
  disabled: boolean;
  onChange: (deviceId: string) => void;
}) {
  const id = useId();
  const devices = useDeviceList(kind, refreshKey);
  if (devices.length === 0) return null;
  const selected = devices.some((device) => device.deviceId === value) ? value : devices[0].deviceId;
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-sage-600">
        {label}
      </label>
      <select
        id={id}
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="block h-10 w-full truncate rounded-lg border border-sage-200 bg-white px-3 pr-8 text-sm text-sage-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:bg-sage-50"
      >
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${index + 1}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function MicLevel({ preview }: { preview: LocalPreview }) {
  const level = useAudioLevel(preview.audioTrack);
  const bars = 12;
  const lit = Math.round(level * bars);
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      <Mic className="h-4 w-4 text-sage-500" />
      <div className="flex h-2 flex-1 gap-0.5">
        {Array.from({ length: bars }, (_, index) => (
          <span key={index} className={`h-full flex-1 rounded-full ${index < lit ? 'bg-primary-500' : 'bg-sage-200'}`} />
        ))}
      </div>
    </div>
  );
}

function ProblemNotice({ problems, onRetry }: { problems: { kind: MediaDeviceKindName; problem: MediaProblem }[]; onRetry: () => void }) {
  if (problems.length === 0) return null;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const same = problems.length === 2 && problems[0].problem === problems[1].problem;
  const items: { kind: MediaDeviceKindName | 'both'; problem: MediaProblem }[] = same
    ? [{ kind: 'both', problem: problems[0].problem }]
    : problems;
  return (
    <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      {items.map(({ kind, problem }) => {
        const help = mediaProblemHelp(problem, kind, userAgent);
        return (
          <div key={kind} className="mb-2 last:mb-0">
            <p className="font-semibold">{help.title}</p>
            <p className="mt-0.5">{help.detail}</p>
          </div>
        );
      })}
      {items.some(({ problem }) => problem !== 'unsupported' && problem !== 'insecure') && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-amber-900 shadow-sm ring-1 ring-amber-200 hover:bg-amber-100"
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      )}
    </div>
  );
}

function ToggleButton({ on, onClick, onLabel, offLabel, onIcon, offIcon }: {
  on: boolean;
  onClick: () => void;
  onLabel: string;
  offLabel: string;
  onIcon: ReactNode;
  offIcon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!on}
      aria-label={on ? onLabel : offLabel}
      title={on ? onLabel : offLabel}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full shadow-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 ${
        on ? 'bg-black/50 text-white backdrop-blur hover:bg-black/70' : 'bg-red-600 text-white hover:bg-red-500'
      }`}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}

/**
 * Camera preview with microphone level, on/off toggles and device selection, shown before joining a
 * call and while waiting to be admitted. Explains blocked or missing devices in plain words.
 */
export function DevicePreview({ preview, compact = false }: { preview: LocalPreview; compact?: boolean }) {
  const videoElement = useRef<HTMLVideoElement>(null);
  const { choices, videoTrack, audioTrack, problems, pending } = preview;

  useEffect(() => {
    const element = videoElement.current;
    if (!videoTrack || !element) return;
    videoTrack.attach(element);
    return () => {
      videoTrack.detach(element);
    };
  }, [videoTrack]);

  const problemList: { kind: MediaDeviceKindName; problem: MediaProblem }[] = [];
  if (choices.videoEnabled && problems.camera) problemList.push({ kind: 'camera', problem: problems.camera });
  if (choices.audioEnabled && problems.microphone) problemList.push({ kind: 'microphone', problem: problems.microphone });

  return (
    <div className="space-y-3">
      <div className={`relative overflow-hidden rounded-2xl bg-[#0b1312] ${compact ? 'aspect-[4/3]' : 'aspect-[4/3] sm:aspect-video'}`}>
        {videoTrack && choices.videoEnabled ? (
          <video
            ref={videoElement}
            muted
            playsInline
            autoPlay
            aria-label="Your camera preview"
            className={`h-full w-full object-cover ${
              // Mirror a front camera like a mirror would; never a rear camera.
              facingModeFromLocalTrack(videoTrack).facingMode === 'environment' ? '' : '-scale-x-100'
            }`}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-white/70">
            {pending ? (
              <>
                <Spinner className="h-7 w-7 text-primary-300" />
                <span>Starting your camera…</span>
              </>
            ) : (
              <>
                <VideoOff className="h-8 w-8" />
                <span>{choices.videoEnabled ? 'Camera unavailable' : 'Your camera is off'}</span>
              </>
            )}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-3 flex justify-center gap-3">
          <ToggleButton
            on={choices.audioEnabled}
            onClick={() => preview.setAudioEnabled(!choices.audioEnabled)}
            onLabel="Turn microphone off"
            offLabel="Turn microphone on"
            onIcon={<Mic className="h-5 w-5" />}
            offIcon={<MicOff className="h-5 w-5" />}
          />
          <ToggleButton
            on={choices.videoEnabled}
            onClick={() => preview.setVideoEnabled(!choices.videoEnabled)}
            onLabel="Turn camera off"
            offLabel="Turn camera on"
            onIcon={<Video className="h-5 w-5" />}
            offIcon={<VideoOff className="h-5 w-5" />}
          />
        </div>
      </div>

      {choices.audioEnabled && audioTrack && <MicLevel preview={preview} />}

      <ProblemNotice problems={problemList} onRetry={preview.retry} />

      {!compact && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <DeviceSelect
            kind="videoinput"
            label="Camera"
            value={choices.videoDeviceId}
            refreshKey={videoTrack}
            disabled={!choices.videoEnabled}
            onChange={(deviceId) => preview.selectDevice('videoinput', deviceId)}
          />
          <DeviceSelect
            kind="audioinput"
            label="Microphone"
            value={choices.audioDeviceId}
            refreshKey={audioTrack}
            disabled={!choices.audioEnabled}
            onChange={(deviceId) => preview.selectDevice('audioinput', deviceId)}
          />
        </div>
      )}
    </div>
  );
}
