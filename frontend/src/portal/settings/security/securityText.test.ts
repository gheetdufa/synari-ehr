import { describe, expect, it } from 'vitest';
import { idleTimeoutChoices, idleTimeoutLabel, isMobileDevice, mfaCoverageText, mfaRolloutText } from './securityText';

describe('security settings text', () => {
  it.each([
    [3, 5, '3 of 5 active team members use 2FA'],
    [1, 1, '1 of 1 active team member uses 2FA'],
    [0, 2, '0 of 2 active team members use 2FA'],
  ])('describes coverage of %i of %i', (enabled, active, text) => {
    expect(mfaCoverageText(enabled, active)).toBe(text);
  });

  it('explains who will be asked to set up two-factor', () => {
    expect(mfaRolloutText(4, 4, true)).toBeNull();
    expect(mfaRolloutText(3, 4, true)).toBe(
      "1 active team member hasn't set up two-factor authentication yet. Once you save, they'll be asked to set it up before they can continue.",
    );
    expect(mfaRolloutText(1, 4, false)).toMatch(/^3 active team members haven't set up two-factor authentication yet, including you\./);
  });

  it('labels and offers idle limits', () => {
    expect(idleTimeoutLabel(5)).toBe('5 minutes');
    expect(idleTimeoutLabel(60)).toBe('1 hour');
    expect(idleTimeoutChoices(30)).toEqual([5, 10, 15, 20, 30, 45, 60]);
    expect(idleTimeoutChoices(25)).toEqual([5, 10, 15, 20, 25, 30, 45, 60]);
  });

  it.each([
    ['Safari on iPhone', '', true],
    ['Chrome on Android', '', true],
    ['Unknown device', 'Mozilla/5.0 (Linux; Android 14) Mobile Safari', true],
    ['Chrome on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', false],
  ])('recognizes %j as a phone: %s', (device, userAgent, mobile) => {
    expect(isMobileDevice(device, userAgent)).toBe(mobile);
  });
});
