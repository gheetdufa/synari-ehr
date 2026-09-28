import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Track } from 'livekit-client';
import { useMediaDeviceSelect, useTrackToggle } from '@livekit/components-react';
import {
  Check,
  ChevronUp,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  Video,
  VideoOff,
} from 'lucide-react';
import type { MediaDeviceKindName } from './mediaErrors';

const BASE =
  'relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b1312] disabled:cursor-not-allowed disabled:opacity-50 sm:h-12 sm:w-12';
const NEUTRAL = 'bg-white/10 text-white hover:bg-white/20';
const OFF = 'bg-white text-[#0b1312] hover:bg-white/90';
const ACTIVE = 'bg-primary-500 text-[#042f2e] hover:bg-primary-400';

/** A round call-control button with a text label under it on larger screens. */
export function ControlButton({
  label,
  icon,
  onClick,
  tone = 'neutral',
  pressed,
  disabled,
  badge,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  tone?: 'neutral' | 'off' | 'active' | 'danger';
  pressed?: boolean;
  disabled?: boolean;
  badge?: ReactNode;
}) {
  const toneClass = {
    neutral: NEUTRAL,
    off: OFF,
    active: ACTIVE,
    danger: 'bg-red-600 text-white hover:bg-red-500',
  }[tone];
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        title={label}
        disabled={disabled}
        onClick={onClick}
        className={`${BASE} ${toneClass} ${tone === 'danger' ? 'w-14 sm:w-16' : ''}`}
      >
        {icon}
        {badge}
      </button>
      <span className="hidden max-w-[5.5rem] truncate text-[11px] text-white/70 sm:block" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

/** A count bubble for a control button (unread messages, people waiting). */
export function ControlBadge({ count, tone = 'accent' }: { count: number; tone?: 'accent' | 'alert' }) {
  if (count <= 0) return null;
  return (
    <span
      className={`absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold ${
        tone === 'alert' ? 'bg-amber-400 text-amber-950' : 'bg-primary-400 text-[#042f2e]'
      }`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function DeviceMenu({ kind, label }: { kind: 'audioinput' | 'videoinput'; label: string }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind, requestPermissions: open });

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isActive = (deviceId: string, index: number) =>
    deviceId === activeDeviceId || (activeDeviceId === 'default' && index === 0 && !devices.some((d) => d.deviceId === 'default'));

  return (
    <div ref={container} className="absolute -right-1 -top-1">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-[#213432] text-white ring-2 ring-[#0b1312] hover:bg-[#2b413e] focus:outline-none focus-visible:ring-primary-300"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="fixed inset-x-3 bottom-24 z-40 rounded-xl border border-white/10 bg-[#121d1c] p-1.5 shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-9 sm:left-1/2 sm:w-72 sm:-translate-x-1/2">
          <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">{label}</p>
          {devices.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-white/70">No devices found.</p>
          ) : (
            <ul role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
              {devices.map((device, index) => {
                const selected = isActive(device.deviceId, index);
                return (
                  <li key={device.deviceId} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      onClick={() => {
                        void setActiveMediaDevice(device.deviceId).catch(() => undefined);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-white hover:bg-white/10"
                    >
                      <Check className={`h-4 w-4 shrink-0 ${selected ? 'text-primary-300' : 'invisible'}`} />
                      <span className="truncate">{device.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${index + 1}`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function MediaToggle({
  source,
  onDeviceError,
}: {
  source: Track.Source.Microphone | Track.Source.Camera;
  onDeviceError: (kind: MediaDeviceKindName, error: Error) => void;
}) {
  const isMic = source === Track.Source.Microphone;
  const kindName: MediaDeviceKindName = isMic ? 'microphone' : 'camera';
  const { toggle, enabled, pending } = useTrackToggle({
    source,
    onDeviceError: (error) => onDeviceError(kindName, error),
  });
  const label = isMic ? (enabled ? 'Mute' : 'Unmute') : enabled ? 'Stop video' : 'Start video';
  const icon = isMic ? (
    enabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />
  ) : enabled ? (
    <Video className="h-5 w-5" />
  ) : (
    <VideoOff className="h-5 w-5" />
  );
  return (
    <div className="relative">
      <ControlButton
        label={label}
        icon={icon}
        tone={enabled ? 'neutral' : 'off'}
        pressed={!enabled}
        disabled={pending}
        onClick={() => void toggle()}
      />
      <DeviceMenu kind={isMic ? 'audioinput' : 'videoinput'} label={isMic ? 'Choose microphone' : 'Choose camera'} />
    </div>
  );
}

function ScreenShareToggle({ onDeviceError }: { onDeviceError: (kind: MediaDeviceKindName, error: Error) => void }) {
  const { toggle, enabled, pending } = useTrackToggle({
    source: Track.Source.ScreenShare,
    captureOptions: { audio: true, selfBrowserSurface: 'exclude' },
    onDeviceError: (error) => {
      // Closing the browser's "choose what to share" dialog is not an error worth reporting.
      if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') onDeviceError('camera', error);
    },
  });
  return (
    <ControlButton
      label={enabled ? 'Stop sharing' : 'Share screen'}
      icon={enabled ? <MonitorX className="h-5 w-5" /> : <MonitorUp className="h-5 w-5" />}
      tone={enabled ? 'active' : 'neutral'}
      pressed={enabled}
      disabled={pending}
      onClick={() => void toggle()}
    />
  );
}

function canShareScreen(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') return false;
  // Mobile browsers either lack screen capture or share only the browser tab poorly.
  return !/android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** The bottom bar of a call: microphone, camera, screen share, chat, extras, and leave. */
export function CallControls({
  chatOpen,
  unreadMessages,
  onToggleChat,
  onLeave,
  leaveLabel = 'Leave',
  onDeviceError,
  extra,
}: {
  chatOpen: boolean;
  unreadMessages: number;
  onToggleChat: () => void;
  onLeave: () => void;
  leaveLabel?: string;
  onDeviceError: (kind: MediaDeviceKindName, error: Error) => void;
  extra?: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Call controls"
      className="flex flex-wrap items-start justify-center gap-1.5 border-t border-white/5 bg-[#0b1312]/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:gap-3"
    >
      <MediaToggle source={Track.Source.Microphone} onDeviceError={onDeviceError} />
      <MediaToggle source={Track.Source.Camera} onDeviceError={onDeviceError} />
      {canShareScreen() && <ScreenShareToggle onDeviceError={onDeviceError} />}
      <ControlButton
        label={chatOpen ? 'Close chat' : 'Chat'}
        icon={<MessageSquare className="h-5 w-5" />}
        tone={chatOpen ? 'active' : 'neutral'}
        pressed={chatOpen}
        onClick={onToggleChat}
        badge={<ControlBadge count={unreadMessages} />}
      />
      {extra}
      <ControlButton label={leaveLabel} icon={<PhoneOff className="h-5 w-5" />} tone="danger" onClick={onLeave} />
    </div>
  );
}
