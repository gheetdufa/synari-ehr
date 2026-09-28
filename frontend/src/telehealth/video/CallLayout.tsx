import '@livekit/components-styles';
import './video.css';
import { useEffect, useState, type ReactNode } from 'react';
import { ConnectionQuality, type Room } from 'livekit-client';
import {
  ConnectionStateToast,
  RoomAudioRenderer,
  RoomContext,
  StartMediaButton,
  useConnectionQualityIndicator,
  useLocalParticipant,
} from '@livekit/components-react';
import { Signal, SignalLow, SignalMedium, WifiOff, X } from 'lucide-react';
import { useNow } from '../useNow';
import { formatElapsed } from '../sessionWindow';
import { mediaProblemHelp, type MediaDeviceKindName, type MediaProblem } from './mediaErrors';

/** Full-screen dark stage for a connected call; provides the LiveKit room to everything inside. */
export function CallRoot({ room, children }: { room: Room; children: ReactNode }) {
  return (
    <RoomContext.Provider value={room}>
      <div
        data-lk-theme="default"
        className="synari-video lk-room-container fixed inset-0 flex h-dvh flex-col overflow-hidden text-white"
      >
        {children}
        <RoomAudioRenderer />
        <StartMediaButton label="Tap to turn on sound and video" />
        <ConnectionStateToast />
      </div>
    </RoomContext.Provider>
  );
}

/** Dark full-screen frame for call states without a room yet (connecting, failed, ended). */
export function CallBackdrop({ children }: { children: ReactNode }) {
  return (
    <div
      data-lk-theme="default"
      className="synari-video fixed inset-0 flex h-dvh flex-col items-center justify-center overflow-y-auto px-4 py-8 text-white"
    >
      {children}
    </div>
  );
}

export function CallLayout({
  header,
  notice,
  stage,
  panel,
  controls,
}: {
  header: ReactNode;
  notice?: ReactNode;
  stage: ReactNode;
  panel?: ReactNode;
  controls: ReactNode;
}) {
  return (
    <>
      <header className="flex min-h-[3.5rem] items-center justify-between gap-3 px-3 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4">
        {header}
      </header>
      {notice}
      <div className="relative flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">{stage}</main>
        {panel}
      </div>
      {controls}
    </>
  );
}

/** A side panel on large screens, a bottom sheet on phones. */
export function SidePanel({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={onClose} aria-hidden="true" />
      <aside
        aria-label={typeof title === 'string' ? title : undefined}
        className="fixed inset-x-0 bottom-0 z-30 flex h-[78dvh] flex-col rounded-t-2xl border-t border-white/10 bg-[#121d1c] shadow-2xl lg:static lg:z-auto lg:h-auto lg:w-96 lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none"
      >
        <div className="flex items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </aside>
    </>
  );
}

const QUALITY: Record<ConnectionQuality, { label: string; className: string; icon: ReactNode }> = {
  [ConnectionQuality.Excellent]: { label: 'Excellent', className: 'text-primary-300', icon: <Signal className="h-4 w-4" /> },
  [ConnectionQuality.Good]: { label: 'Good', className: 'text-amber-300', icon: <SignalMedium className="h-4 w-4" /> },
  [ConnectionQuality.Poor]: { label: 'Weak', className: 'text-red-300', icon: <SignalLow className="h-4 w-4" /> },
  [ConnectionQuality.Lost]: { label: 'Lost', className: 'text-red-300', icon: <WifiOff className="h-4 w-4" /> },
  [ConnectionQuality.Unknown]: { label: 'Checking', className: 'text-white/60', icon: <Signal className="h-4 w-4" /> },
};

/** Your own connection quality, as LiveKit measures it. */
export function ConnectionIndicator() {
  const { localParticipant } = useLocalParticipant();
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  const info = QUALITY[quality] ?? QUALITY[ConnectionQuality.Unknown];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-1 text-xs ${info.className}`}
      title={`Your connection: ${info.label}`}
    >
      {info.icon}
      <span className="sr-only sm:not-sr-only">{info.label}</span>
    </span>
  );
}

/** Time since `since` (ms since epoch), ticking every second. */
export function SessionTimer({ since, label = 'Time in session' }: { since: number; label?: string }) {
  const now = useNow(1000);
  return (
    <span className="rounded-full bg-white/5 px-2 py-1 font-mono text-xs tabular-nums text-white/80" title={label}>
      <span className="sr-only">{label}: </span>
      {formatElapsed(now - since)}
    </span>
  );
}

export interface DeviceIssue {
  kind: MediaDeviceKindName;
  problem: MediaProblem;
}

/** A dismissible explanation for a camera or microphone that stopped or couldn't start during a call. */
export function DeviceIssueBanner({ issue, onDismiss }: { issue: DeviceIssue | null; onDismiss: () => void }) {
  const [userAgent] = useState(() => (typeof navigator === 'undefined' ? '' : navigator.userAgent));
  if (!issue) return null;
  const help = mediaProblemHelp(issue.problem, issue.kind, userAgent);
  return (
    <div role="alert" className="mx-3 mb-2 flex items-start gap-3 rounded-xl border border-amber-300/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100 sm:mx-4">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{help.title}</p>
        <p className="mt-0.5 text-amber-100/80">{help.detail}</p>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded p-1 text-amber-100/70 hover:text-amber-50">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
