import { describe, expect, it } from 'vitest';
import type { ClientDetail } from '../../api/clients';
import type { PracticeSettings } from '../../api/practice';
import { blockerFromReason, messagingBlocker } from './messagingBlocker';

const client = (changes: Partial<ClientDetail> = {}) =>
  ({ status: 'active', portal_enabled: true, portal_messaging: true, ...changes }) as ClientDetail;
const practice = (messagingEnabled: boolean) => ({ messaging_enabled: messagingEnabled }) as PracticeSettings;

describe('messagingBlocker', () => {
  it('allows active and prospective clients with portal messaging', () => {
    expect(messagingBlocker(client(), practice(true))).toBeNull();
    expect(messagingBlocker(client({ status: 'prospective' }), undefined)).toBeNull();
  });

  it.each([
    [client(), practice(false), 'Secure messaging is turned off for this practice', 'settings'],
    [client({ portal_enabled: false }), practice(true), "This client doesn't have client portal access", 'chart'],
    [client({ status: 'archived' }), practice(true), "This client doesn't have client portal access", 'chart'],
    [client({ status: 'inactive' }), practice(true), "This client doesn't have client portal access", 'chart'],
    [client({ portal_messaging: false }), practice(true), 'Secure messaging is turned off for this client', 'chart'],
  ])('explains why messages are refused (%#)', (record, settings, reason, fixIn) => {
    expect(messagingBlocker(record, settings)).toEqual({ reason, fixIn });
  });
});

describe('blockerFromReason', () => {
  it('recognizes the API reasons for refusing a message', () => {
    expect(blockerFromReason('Secure messaging is turned off for this practice')).toEqual({
      reason: 'Secure messaging is turned off for this practice',
      fixIn: 'settings',
    });
    expect(blockerFromReason("This client doesn't have client portal access")?.fixIn).toBe('chart');
  });

  it('ignores other conflicts', () => {
    expect(blockerFromReason('An attachment was already sent; upload it again')).toBeNull();
  });
});
