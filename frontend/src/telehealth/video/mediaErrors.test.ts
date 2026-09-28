import { describe, expect, it } from 'vitest';
import { browserFamily, classifyMediaError, environmentProblem, mediaProblemHelp } from './mediaErrors';

const named = (name: string) => Object.assign(new Error('x'), { name });

describe('classifyMediaError', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'not_found'],
    ['OverconstrainedError', 'not_found'],
    ['NotReadableError', 'in_use'],
    ['TypeError', 'other'],
  ])('%s -> %s', (name, expected) => {
    expect(classifyMediaError(named(name))).toBe(expected);
  });

  it('handles non-errors', () => {
    expect(classifyMediaError('nope')).toBe('other');
  });
});

describe('browserFamily', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1', 'ios'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36', 'android'],
    ['Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 'safari'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0', 'edge'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'chrome'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'firefox'],
  ])('%s', (ua, expected) => {
    expect(browserFamily(ua)).toBe(expected);
  });
});

describe('mediaProblemHelp', () => {
  it('gives browser-specific steps for blocked permissions', () => {
    const help = mediaProblemHelp('denied', 'camera', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    expect(help.title).toBe('Your camera is blocked');
    expect(help.detail).toContain('Settings app');
  });

  it('explains a missing camera still allows audio', () => {
    expect(mediaProblemHelp('not_found', 'camera', '').detail).toContain('audio only');
  });
});

describe('environmentProblem', () => {
  it('reports that jsdom has no media devices', () => {
    expect(environmentProblem()).toBe('unsupported');
  });
});
