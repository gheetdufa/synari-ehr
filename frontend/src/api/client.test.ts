import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MFA_SETUP_REQUIRED_DETAIL,
  api,
  getAccessToken,
  onMfaSetupRequired,
  onSessionExpired,
  tokenStore,
  type TokenPair,
} from './client';

/** A token the client can read the expiry of (it never checks the signature). */
function jwt(expiresInSeconds: number): string {
  return `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }))}.signature`;
}

function tokens(refreshToken: string, expiresInSeconds: number): TokenPair {
  return { access_token: jwt(expiresInSeconds), refresh_token: refreshToken, expires_in: 900 };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type LockCallback = () => Promise<boolean>;

function installLocks(request: (name: string, callback: LockCallback) => Promise<boolean>) {
  Object.defineProperty(navigator, 'locks', { value: { request: vi.fn(request) }, configurable: true });
  return (navigator as unknown as { locks: { request: ReturnType<typeof vi.fn> } }).locks.request;
}

describe('token refresh', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('refreshes an expiring token once for concurrent callers when Web Locks are unavailable', async () => {
    const fresh = tokens('refresh-2', 900);
    tokenStore.set('staff', tokens('refresh-1', -10));
    fetchMock.mockResolvedValue(jsonResponse(fresh));

    const results = await Promise.all([getAccessToken('staff'), getAccessToken('staff')]);

    expect(results).toEqual([fresh.access_token, fresh.access_token]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/auth\/refresh$/);
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: 'refresh-1' });
    expect(tokenStore.get('staff')?.refresh_token).toBe('refresh-2');
  });

  it('uses the tokens another tab refreshed while this one waited for the lock', async () => {
    const fromOtherTab = tokens('refresh-2', 900);
    tokenStore.set('staff', tokens('refresh-1', -10));
    const request = installLocks(async (_name, callback) => {
      tokenStore.set('staff', fromOtherTab);
      return callback();
    });

    await expect(getAccessToken('staff')).resolves.toBe(fromOtherTab.access_token);

    expect(request).toHaveBeenCalledWith('synari-refresh-staff', expect.any(Function));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes under the lock when no other tab has, per realm', async () => {
    const fresh = tokens('client-refresh-2', 900);
    tokenStore.set('client', tokens('client-refresh-1', -10));
    fetchMock.mockResolvedValue(jsonResponse(fresh));
    const request = installLocks((_name, callback) => callback());

    await expect(getAccessToken('client')).resolves.toBe(fresh.access_token);

    expect(request).toHaveBeenCalledWith('synari-refresh-client', expect.any(Function));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/portal\/auth\/refresh$/);
    expect(tokenStore.get('client')?.refresh_token).toBe('client-refresh-2');
  });

  it('signs out when the refresh token is refused', async () => {
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    tokenStore.set('staff', tokens('refresh-1', -10));
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'Session expired, please sign in again' }, 401));

    await expect(getAccessToken('staff')).resolves.toBeNull();

    expect(tokenStore.get('staff')).toBeNull();
    expect(expired).toHaveBeenCalledWith('staff');
    unsubscribe();
  });
});

describe('two-factor enrollment', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    tokenStore.set('staff', tokens('refresh-1', 900));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('tells listeners when a staff request is refused until two-factor is set up', async () => {
    const listener = vi.fn();
    const unsubscribe = onMfaSetupRequired(listener);
    fetchMock.mockResolvedValue(jsonResponse({ detail: MFA_SETUP_REQUIRED_DETAIL }, 403));

    await expect(api('/clients')).rejects.toMatchObject({ status: 403, message: MFA_SETUP_REQUIRED_DETAIL });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('ignores other refusals', async () => {
    const listener = vi.fn();
    const unsubscribe = onMfaSetupRequired(listener);
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Your role can't do that" }, 403));

    await expect(api('/team')).rejects.toMatchObject({ status: 403 });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
