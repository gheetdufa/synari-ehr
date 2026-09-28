import { describe, expect, it } from 'vitest';
import { isSharedSession, joinNames, sessionLabel } from './sessionLabels';

describe('session labels', () => {
  it.each([
    [[], ''],
    [['Sam'], 'Sam'],
    [['Sam', 'Jo'], 'Sam & Jo'],
    [['Sam', 'Jo', 'Ali'], 'Sam, Jo & Ali'],
  ])('joins %j as %s', (names, expected) => {
    expect(joinNames(names)).toBe(expected);
  });

  it('names group and joint sessions, and nothing for individual ones', () => {
    expect(sessionLabel({ is_group: true, other_participants: [] })).toBe('Group session');
    expect(sessionLabel({ is_group: false, other_participants: ['Jo'] })).toBe('Joint session with Jo');
    expect(sessionLabel({ is_group: false, other_participants: [] })).toBeNull();
    expect(isSharedSession({ is_group: false, other_participants: [] })).toBe(false);
    expect(isSharedSession({ is_group: true, other_participants: [] })).toBe(true);
  });
});
