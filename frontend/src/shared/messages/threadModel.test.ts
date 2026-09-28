import { describe, expect, it } from 'vitest';
import type { SenderRole } from '../../api/messages';
import {
  buildThreadItems,
  dayLabel,
  formatListTime,
  isFlagged,
  mergePages,
  newestUnreadIncomingId,
  nextBeforeId,
  portalViewSender,
  readReceipts,
  relativeTime,
  staffViewSender,
  upsertIntoPages,
  type ThreadMessage,
} from './threadModel';

const NY = 'America/New_York';
/** Friday, Sep 25 2026, 12:00 PM in New York. */
const NOW = Date.parse('2026-09-25T16:00:00Z');

function message(id: number, sender: SenderRole, createdAt: string, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    conversation_id: 1,
    sender_role: sender,
    sender_name: sender === 'staff' ? 'Dana Lee, LCSW' : null,
    body: `Message ${id}`,
    removed: false,
    is_automatic: false,
    attachments: [],
    created_at: createdAt,
    read_by_recipient: false,
    ...extra,
  };
}

/** Intl uses narrow no-break spaces in times ("9:00 AM"); compare with plain spaces. */
const plain = (text: string) => text.replace(/\s/g, ' ');

function summarize(items: ReturnType<typeof buildThreadItems>) {
  return items.map((item) =>
    item.kind === 'day' ? `day:${item.label}` : `${item.senderRole}${item.automatic ? '(auto)' : ''}:${item.messages.map((m) => m.id).join(',')}`,
  );
}

describe('buildThreadItems', () => {
  it('returns nothing for an empty thread', () => {
    expect(buildThreadItems([], NY, NOW)).toEqual([]);
  });

  it('groups consecutive messages from one sender sent close together', () => {
    const items = buildThreadItems(
      [
        message(1, 'client', '2026-09-25T13:00:00Z'),
        message(2, 'client', '2026-09-25T13:03:00Z'),
        message(3, 'client', '2026-09-25T13:08:30Z'),
        message(4, 'staff', '2026-09-25T13:09:00Z'),
        message(5, 'staff', '2026-09-25T13:10:00Z'),
        message(6, 'client', '2026-09-25T13:11:00Z'),
      ],
      NY,
      NOW,
    );
    expect(summarize(items)).toEqual(['day:Today', 'client:1,2', 'client:3', 'staff:4,5', 'client:6']);
  });

  it('shows a group time only where the conversation pauses or the day ends', () => {
    const items = buildThreadItems(
      [
        message(1, 'client', '2026-09-24T13:00:00Z'),
        message(2, 'client', '2026-09-25T13:00:00Z'),
        message(3, 'client', '2026-09-25T13:03:00Z'),
        message(4, 'staff', '2026-09-25T13:04:00Z'),
        message(5, 'client', '2026-09-25T13:20:00Z'),
      ],
      NY,
      NOW,
    );
    const times = items.flatMap((item) => (item.kind === 'group' ? [`${item.messages[0].id}:${item.showTime}`] : []));
    expect(times).toEqual(['1:true', '2:false', '4:true', '5:true']);
  });

  it('keeps automatic replies in their own group', () => {
    const items = buildThreadItems(
      [
        message(1, 'staff', '2026-09-25T13:00:00Z'),
        message(2, 'staff', '2026-09-25T13:00:30Z', { is_automatic: true }),
        message(3, 'staff', '2026-09-25T13:01:00Z'),
      ],
      NY,
      NOW,
    );
    expect(summarize(items)).toEqual(['day:Today', 'staff:1', 'staff(auto):2', 'staff:3']);
  });

  it('starts a new group when someone else on the same side writes', () => {
    const colleague = { sender_name: 'Sam Ortiz, PhD', sender_staff_id: 2 };
    const parent = { sender_name: 'Pat Rivera (for Alex)', sender_contact_id: 9 };
    const items = buildThreadItems(
      [
        message(1, 'staff', '2026-09-25T13:00:00Z', { sender_staff_id: 1 }),
        message(2, 'staff', '2026-09-25T13:01:00Z', colleague),
        message(3, 'staff', '2026-09-25T13:02:00Z', colleague),
        message(4, 'client', '2026-09-25T13:03:00Z'),
        message(5, 'client', '2026-09-25T13:04:00Z', parent),
      ],
      NY,
      NOW,
    );
    expect(summarize(items)).toEqual(['day:Today', 'staff:1', 'staff:2,3', 'client:4', 'client:5']);
  });

  it("starts a new day at midnight in the viewer's time zone, not UTC", () => {
    const messages = [
      // 7:58 PM and 8:02 PM on Sep 23 in New York, either side of midnight UTC.
      message(1, 'client', '2026-09-23T23:58:00Z'),
      message(2, 'client', '2026-09-24T00:02:00Z'),
      // 11:58 PM Sep 24 and 12:02 AM Sep 25 in New York.
      message(3, 'client', '2026-09-25T03:58:00Z'),
      message(4, 'client', '2026-09-25T04:02:00Z'),
    ];
    expect(summarize(buildThreadItems(messages, NY, NOW))).toEqual([
      'day:Wednesday',
      'client:1,2',
      'day:Yesterday',
      'client:3',
      'day:Today',
      'client:4',
    ]);
    expect(summarize(buildThreadItems(messages, 'UTC', NOW))).toEqual([
      'day:Wednesday',
      'client:1',
      'day:Yesterday',
      'client:2',
      'day:Today',
      'client:3,4',
    ]);
  });
});

describe('dayLabel', () => {
  it.each([
    ['2026-09-25T13:00:00Z', 'Today'],
    ['2026-09-24T13:00:00Z', 'Yesterday'],
    ['2026-09-21T13:00:00Z', 'Monday'],
    ['2026-09-10T13:00:00Z', 'Thu, Sep 10'],
    ['2025-12-31T13:00:00Z', 'Dec 31, 2025'],
  ])('labels %s as %s', (iso, label) => {
    expect(dayLabel(iso, NY, NOW)).toBe(label);
  });

  it('uses the viewer zone to decide the day', () => {
    // 10 PM on Sep 24 in New York, 2 AM on Sep 25 in UTC.
    expect(dayLabel('2026-09-25T02:00:00Z', NY, NOW)).toBe('Yesterday');
    expect(dayLabel('2026-09-25T02:00:00Z', 'UTC', NOW)).toBe('Today');
  });
});

describe('formatListTime', () => {
  it.each([
    [NOW - 30_000, 'Now'],
    [NOW - 12 * 60_000, '12m'],
    [Date.parse('2026-09-25T13:00:00Z'), '9:00 AM'],
    [Date.parse('2026-09-24T13:00:00Z'), 'Yesterday'],
    [Date.parse('2026-09-21T13:00:00Z'), 'Mon'],
    [Date.parse('2026-09-10T13:00:00Z'), 'Sep 10'],
    [Date.parse('2025-12-31T13:00:00Z'), 'Dec 31, 2025'],
  ])('formats %s as %s', (time, label) => {
    expect(plain(formatListTime(new Date(time).toISOString(), NY, NOW))).toBe(label);
  });
});

describe('relativeTime', () => {
  it.each([
    [NOW - 20_000, 'just now'],
    [NOW - 5 * 60_000, '5m ago'],
    [NOW - 3 * 3_600_000, '3h ago'],
    [NOW - 2 * 86_400_000, '2d ago'],
    [Date.parse('2026-08-01T15:00:00Z'), 'Aug 1, 2026'],
  ])('formats %s as %s', (time, label) => {
    expect(relativeTime(new Date(time).toISOString(), NY, NOW)).toBe(label);
  });
});

describe('readReceipts', () => {
  it('marks the latest read own message and an unread newer one as sent', () => {
    const messages = [
      message(1, 'staff', '2026-09-25T13:00:00Z', { read_by_recipient: true }),
      message(2, 'staff', '2026-09-25T13:01:00Z', { read_by_recipient: true }),
      message(3, 'client', '2026-09-25T13:02:00Z'),
      message(4, 'staff', '2026-09-25T13:03:00Z'),
    ];
    expect(readReceipts(messages, 'staff')).toEqual({ readId: 2, sentId: 4 });
  });

  it('shows only "Read" when the latest own message was read', () => {
    const messages = [
      message(1, 'client', '2026-09-25T13:00:00Z', { read_by_recipient: true }),
      message(2, 'client', '2026-09-25T13:01:00Z', { read_by_recipient: true }),
    ];
    expect(readReceipts(messages, 'client')).toEqual({ readId: 2, sentId: null });
  });

  it('ignores removed messages and automatic replies', () => {
    const messages = [
      message(1, 'staff', '2026-09-25T13:00:00Z', { read_by_recipient: true }),
      message(2, 'staff', '2026-09-25T13:01:00Z', { read_by_recipient: true, is_automatic: true }),
      message(3, 'staff', '2026-09-25T13:02:00Z', { removed: true }),
    ];
    expect(readReceipts(messages, 'staff')).toEqual({ readId: 1, sentId: null });
  });

  it('has nothing to show before the viewer has written', () => {
    expect(readReceipts([message(1, 'client', '2026-09-25T13:00:00Z')], 'staff')).toEqual({
      readId: null,
      sentId: null,
    });
  });
});

describe('newestUnreadIncomingId', () => {
  it("finds the newest message from the other side the viewer hasn't read", () => {
    const messages = [
      message(1, 'client', '2026-09-25T13:00:00Z', { read_by_recipient: true }),
      message(2, 'client', '2026-09-25T13:01:00Z'),
      message(3, 'client', '2026-09-25T13:02:00Z', { removed: true }),
      message(4, 'staff', '2026-09-25T13:03:00Z'),
    ];
    expect(newestUnreadIncomingId(messages, 'staff')).toBe(2);
  });

  it('counts automatic replies as unread for the client', () => {
    const messages = [message(1, 'staff', '2026-09-25T13:00:00Z', { is_automatic: true })];
    expect(newestUnreadIncomingId(messages, 'client')).toBe(1);
  });

  it('returns null when everything is read', () => {
    const messages = [message(1, 'client', '2026-09-25T13:00:00Z', { read_by_recipient: true })];
    expect(newestUnreadIncomingId(messages, 'staff')).toBeNull();
  });
});

describe('staffViewSender', () => {
  const at = '2026-09-25T13:00:00Z';
  const parent = { sender_name: 'Pat Rivera (for Alex)', sender_contact_id: 9 };
  const colleague = { sender_name: 'Sam Ortiz, PhD', sender_staff_id: 2 };
  const clinician = { sender_name: 'Dana Lee, LCSW', sender_staff_id: 1 };
  // Dana (1) is the conversation's clinician; Sam (2) supervises her.
  const asDana = staffViewSender({ staffId: 1, conversationClinicianId: 1, clientName: 'Alex' });
  const asSam = staffViewSender({ staffId: 2, conversationClinicianId: 1, clientName: 'Alex' });

  it.each([
    ['the client, to their clinician', asDana, message(1, 'client', at), { own: false, name: 'Alex', showName: false }],
    ['a parent writing for the client', asDana, message(2, 'client', at, parent), { own: false, name: 'Pat Rivera (for Alex)', showName: true }],
    ['the clinician, to themselves', asDana, message(3, 'staff', at, clinician), { own: true, name: 'You', showName: false }],
    ['a colleague replying, to the clinician', asDana, message(4, 'staff', at, colleague), { own: false, name: 'Sam Ortiz, PhD', showName: true }],
    ['the supervisor, to themselves', asSam, message(5, 'staff', at, colleague), { own: true, name: 'You', showName: false }],
    ['the clinician, to their supervisor', asSam, message(6, 'staff', at, clinician), { own: false, name: 'Dana Lee, LCSW', showName: true }],
    ['an away reply, to the clinician', asDana, message(7, 'staff', at, { is_automatic: true }), { own: true, name: 'You', showName: false }],
    ['an away reply, to the supervisor', asSam, message(8, 'staff', at, { is_automatic: true }), { own: false, name: 'Dana Lee, LCSW', showName: false }],
  ])('describes %s', (_case, view, input, expected) => {
    expect(view(input)).toEqual(expected);
  });
});

describe('portalViewSender', () => {
  const at = '2026-09-25T13:00:00Z';
  // The portal marks the signed-in person's own messages (sent_by_me); other client-side
  // messages are named: a parent writing for the client, or the client to their parent.
  const asAlex = portalViewSender({ clinicianName: 'Dana Lee, LCSW', clientFirstName: 'Alex' });
  const asPat = asAlex;
  const byPat = { sender_name: 'Pat Rivera (for Alex)' };
  const mine = { sent_by_me: true };

  it.each([
    ['their clinician', asAlex, message(1, 'staff', at), { own: false, name: 'Dana Lee, LCSW', showName: false }],
    ['another staff member', asAlex, message(2, 'staff', at, { sender_name: 'Sam Ortiz, PhD' }), { own: false, name: 'Sam Ortiz, PhD', showName: true }],
    ['an away reply', asAlex, message(3, 'staff', at, { is_automatic: true }), { own: false, name: 'Dana Lee, LCSW', showName: false }],
    ['the client, to themselves', asAlex, message(4, 'client', at, mine), { own: true, name: 'You', showName: false }],
    ['a parent, to the client', asAlex, message(5, 'client', at, byPat), { own: false, name: 'Pat Rivera (for Alex)', showName: true }],
    ['a parent, to themselves', asPat, message(6, 'client', at, { ...byPat, ...mine }), { own: true, name: 'You', showName: false }],
    ['the client, to their parent', asPat, message(7, 'client', at), { own: false, name: 'Alex', showName: true }],
    ['another parent, to a parent', asPat, message(8, 'client', at, { sender_name: 'Sky Rivera (for Alex)' }), { own: false, name: 'Sky Rivera (for Alex)', showName: true }],
  ])('describes %s', (_case, view, input, expected) => {
    expect(view(input)).toEqual(expected);
  });
});

describe('isFlagged', () => {
  it('flags high and moderate risk client messages only', () => {
    expect(isFlagged(message(1, 'client', '2026-09-25T13:00:00Z', { risk_level: 'high' }))).toBe(true);
    expect(isFlagged(message(2, 'client', '2026-09-25T13:00:00Z', { risk_level: 'moderate' }))).toBe(true);
    expect(isFlagged(message(3, 'client', '2026-09-25T13:00:00Z', { risk_level: 'low' }))).toBe(false);
    expect(isFlagged(message(4, 'staff', '2026-09-25T13:00:00Z', { risk_level: 'high' }))).toBe(false);
    expect(isFlagged(message(5, 'client', '2026-09-25T13:00:00Z'))).toBe(false);
  });
});

describe('paging helpers', () => {
  const ids = (list: { id: number }[]) => list.map((item) => item.id);
  const page = (...pageIds: number[]) => pageIds.map((id) => ({ id }));

  it('merges newest-first pages into one oldest-first list without duplicates', () => {
    expect(ids(mergePages([page(4, 5, 6), page(1, 2, 3)]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(mergePages([page(5, 6, 7), page(3, 4, 5)]))).toEqual([3, 4, 5, 6, 7]);
    expect(mergePages([])).toEqual([]);
  });

  it('pages back from the oldest message until a short page', () => {
    expect(nextBeforeId(page(7, 8, 9), 3)).toBe(7);
    expect(nextBeforeId(page(1, 2), 3)).toBeUndefined();
    expect(nextBeforeId([], 3)).toBeUndefined();
  });

  it('replaces a message in place or appends it to the newest page', () => {
    const pages = [[{ id: 4, body: 'new' }], [{ id: 1, body: 'old' }]];
    expect(upsertIntoPages(pages, { id: 1, body: '' })).toEqual([[{ id: 4, body: 'new' }], [{ id: 1, body: '' }]]);
    expect(upsertIntoPages(pages, { id: 5, body: 'sent' })).toEqual([
      [
        { id: 4, body: 'new' },
        { id: 5, body: 'sent' },
      ],
      [{ id: 1, body: 'old' }],
    ]);
    expect(upsertIntoPages([], { id: 1, body: 'first' })).toEqual([[{ id: 1, body: 'first' }]]);
  });
});
