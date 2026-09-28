/** Turning camera/microphone failures into plain-language help. */

export type MediaDeviceKindName = 'camera' | 'microphone';
export type MediaProblem = 'denied' | 'not_found' | 'in_use' | 'insecure' | 'unsupported' | 'other';

/** Classify a getUserMedia / LiveKit device error by its DOMException name. */
export function classifyMediaError(error: unknown): MediaProblem {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'not_found';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in_use';
    default:
      return 'other';
  }
}

/** Problems we can know about before asking for devices at all. */
export function environmentProblem(): MediaProblem | null {
  if (typeof window === 'undefined') return 'unsupported';
  if (window.isSecureContext === false) return 'insecure';
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return 'unsupported';
  return null;
}

export type BrowserFamily = 'ios' | 'android' | 'safari' | 'firefox' | 'edge' | 'chrome' | 'other';

export function browserFamily(userAgent: string): BrowserFamily {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (ua.includes('android')) return 'android';
  if (ua.includes('firefox')) return 'firefox';
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('chrome') || ua.includes('crios')) return 'chrome';
  if (ua.includes('safari')) return 'safari';
  return 'other';
}

const PERMISSION_STEPS: Record<BrowserFamily, string> = {
  ios: 'Open the Settings app, scroll to Safari (or the browser you are using), set Camera and Microphone to Allow, then come back and tap "Try again".',
  android: 'Tap the icon to the left of the web address, choose Permissions, allow Camera and Microphone, then tap "Try again".',
  safari: 'In the menu bar choose Safari > Settings for This Website, set Camera and Microphone to Allow, then click "Try again".',
  firefox: 'Click the camera icon in the address bar, remove the "Blocked" permissions, then click "Try again".',
  edge: 'Click the lock icon in the address bar, set Camera and Microphone to Allow, then click "Try again".',
  chrome: 'Click the camera icon (or the lock) in the address bar, choose Allow for camera and microphone, then click "Try again".',
  other: "Open your browser's site settings for this page, allow the camera and microphone, then try again.",
};

export interface MediaHelp {
  title: string;
  detail: string;
}

/** What to tell someone whose camera or microphone didn't start. */
export function mediaProblemHelp(
  problem: MediaProblem,
  kind: MediaDeviceKindName | 'both',
  userAgent: string,
): MediaHelp {
  const device = kind === 'both' ? 'camera and microphone' : kind;
  const verb = kind === 'both' ? 'are' : 'is';
  const stillJoin = {
    camera: ' with audio only',
    microphone: ", but others won't hear you",
    both: ", but others won't see or hear you",
  }[kind];
  switch (problem) {
    case 'denied':
      return { title: `Your ${device} ${verb} blocked`, detail: PERMISSION_STEPS[browserFamily(userAgent)] };
    case 'not_found':
      return {
        title: `No ${device} found`,
        detail: `Connect a ${device} (or choose another one below). You can still join${stillJoin}.`,
      };
    case 'in_use':
      return {
        title: `Your ${device} ${verb} busy`,
        detail: 'Another app or browser tab may be using it. Close other video apps, then try again.',
      };
    case 'insecure':
      return {
        title: 'This page needs a secure connection',
        detail: 'Browsers only allow the camera and microphone on https:// pages. Open the link exactly as it was sent to you.',
      };
    case 'unsupported':
      return {
        title: "This browser can't use a camera or microphone",
        detail: 'Please use a recent version of Chrome, Safari, Edge or Firefox.',
      };
    case 'other':
      return { title: `Your ${device} didn't start`, detail: 'Try again, or choose a different device.' };
  }
}
