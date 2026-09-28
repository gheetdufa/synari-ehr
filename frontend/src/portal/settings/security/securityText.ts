import { IDLE_TIMEOUT_OPTIONS, type SecurityEventSeverity } from '../../../api/security';

export const SEVERITY_LABELS: Record<SecurityEventSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

export const SEVERITY_TONES: Record<SecurityEventSeverity, 'info' | 'warning' | 'danger'> = {
  info: 'info',
  warning: 'warning',
  critical: 'danger',
};

/** "3 of 5 active team members use 2FA". */
export function mfaCoverageText(enabled: number, active: number): string {
  return `${enabled} of ${active} active team ${active === 1 ? 'member uses' : 'members use'} 2FA`;
}

/**
 * What happens when a practice starts requiring two-factor authentication, or null when everyone
 * already uses it.
 */
export function mfaRolloutText(enabled: number, active: number, youHaveIt: boolean): string | null {
  const missing = active - enabled;
  if (missing <= 0) return null;
  const who = missing === 1 ? "1 active team member hasn't" : `${missing} active team members haven't`;
  const includingYou = youHaveIt ? '' : ', including you';
  return `${who} set up two-factor authentication yet${includingYou}. Once you save, they'll be asked to set it up before they can continue.`;
}

/** "5 minutes", "1 hour". */
export function idleTimeoutLabel(minutes: number): string {
  return minutes === 60 ? '1 hour' : `${minutes} minutes`;
}

/** The idle limits to offer, including a current value outside the usual choices. */
export function idleTimeoutChoices(current: number): number[] {
  const choices: number[] = [...IDLE_TIMEOUT_OPTIONS];
  return choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);
}

/** Whether a signed-in device looks like a phone or tablet, for its icon. */
export function isMobileDevice(device: string, userAgent: string): boolean {
  return /iphone|ipad|android|mobile/i.test(`${device} ${userAgent}`);
}
