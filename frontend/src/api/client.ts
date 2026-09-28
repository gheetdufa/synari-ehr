import { absoluteApiUrl } from '../lib/config';

/** Which kind of account a request is made as. Tokens for each are stored separately. */
export type Realm = 'staff' | 'client';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Error thrown for any non-2xx response, carrying the API's `detail`. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(ApiError.messageFor(status, detail));
    this.status = status;
    this.detail = detail;
  }

  private static messageFor(status: number, detail: unknown): string {
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object' && 'message' in detail) {
      return String((detail as { message: unknown }).message);
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as { msg?: string; loc?: unknown[] };
      const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : undefined;
      return field && first.msg ? `${String(field)}: ${first.msg}` : first.msg ?? 'Invalid input';
    }
    if (status === 0) return "Can't reach the server. Check your connection and try again.";
    if (status >= 500) return 'Something went wrong on our end. Please try again.';
    return `Request failed (${status})`;
  }
}

const STORAGE_KEYS: Record<Realm, string> = {
  staff: 'synari.staff.tokens',
  client: 'synari.client.tokens',
};

const REFRESH_PATHS: Record<Realm, string> = {
  staff: '/auth/refresh',
  client: '/portal/auth/refresh',
};

type SessionListener = (realm: Realm) => void;
const expiredListeners = new Set<SessionListener>();

/** Token storage per realm, in localStorage so sessions survive reloads. */
export const tokenStore = {
  get(realm: Realm): TokenPair | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS[realm]);
      return raw ? (JSON.parse(raw) as TokenPair) : null;
    } catch {
      return null;
    }
  },
  set(realm: Realm, tokens: TokenPair): void {
    localStorage.setItem(
      STORAGE_KEYS[realm],
      JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
      }),
    );
  },
  clear(realm: Realm): void {
    localStorage.removeItem(STORAGE_KEYS[realm]);
  },
};

/** Called when a realm's session can't be refreshed any more (the user must sign in again). */
export function onSessionExpired(listener: SessionListener): () => void {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
}

/** The API's answer to anything but enrollment while a session must set up two-factor first. */
export const MFA_SETUP_REQUIRED_DETAIL = 'Set up two-factor authentication to continue.';

const mfaSetupListeners = new Set<() => void>();

/** Called when a staff request is refused until two-factor authentication is set up. */
export function onMfaSetupRequired(listener: () => void): () => void {
  mfaSetupListeners.add(listener);
  return () => mfaSetupListeners.delete(listener);
}

const refreshing: Partial<Record<Realm, Promise<boolean>>> = {};

async function exchangeRefreshToken(realm: Realm, refreshToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${absoluteApiUrl()}${REFRESH_PATHS[realm]}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) return false;
    tokenStore.set(realm, (await response.json()) as TokenPair);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh tokens rotate on every use and reusing an old one revokes the session, so tabs take
 * turns: the refresh runs under a Web Lock shared by every tab of this origin. Inside the lock, a
 * stored refresh token that differs from the one this tab started with means another tab already
 * refreshed, and its new tokens are used as they are.
 */
async function refreshTokens(realm: Realm): Promise<boolean> {
  const startedWith = tokenStore.get(realm)?.refresh_token;
  if (!startedWith) return false;
  refreshing[realm] ??= (async () => {
    const refreshOnce = async () => {
      const stored = tokenStore.get(realm);
      if (!stored) return false;
      if (stored.refresh_token !== startedWith) return true;
      return exchangeRefreshToken(realm, stored.refresh_token);
    };
    try {
      const locks: LockManager | undefined = navigator.locks;
      return locks ? await locks.request(`synari-refresh-${realm}`, refreshOnce) : await refreshOnce();
    } finally {
      delete refreshing[realm];
    }
  })();
  return refreshing[realm]!;
}

function expiresSoon(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return !payload.exp || payload.exp * 1000 - Date.now() < 30_000;
  } catch {
    return true;
  }
}

/** A fresh access token for the realm, refreshing if needed; null when signed out. */
export async function getAccessToken(realm: Realm): Promise<string | null> {
  const current = tokenStore.get(realm);
  if (!current) return null;
  if (!expiresSoon(current.access_token)) return current.access_token;
  if (await refreshTokens(realm)) return tokenStore.get(realm)?.access_token ?? null;
  tokenStore.clear(realm);
  expiredListeners.forEach((listener) => listener(realm));
  return null;
}

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  realm?: Realm | null;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Query parameters; an array repeats its key once per value. */
  query?: Record<string, QueryValue | readonly (string | number)[]>;
  body?: unknown;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${absoluteApiUrl()}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
    else if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function realmOf(options: RequestOptions): Realm | null {
  return options.realm === undefined ? 'staff' : options.realm;
}

async function send(path: string, options: RequestOptions, retry: boolean): Promise<Response> {
  const realm = realmOf(options);
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const token = realm ? tokenStore.get(realm)?.access_token : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, null);
  }

  if (response.status === 401 && realm && token && retry) {
    if (await refreshTokens(realm)) return send(path, options, false);
    tokenStore.clear(realm);
    expiredListeners.forEach((listener) => listener(realm));
  }
  return response;
}

async function errorFrom(response: Response, realm: Realm | null): Promise<ApiError> {
  let detail: unknown = null;
  try {
    const data = (await response.json()) as { detail?: unknown };
    detail = data.detail ?? data;
  } catch {
    detail = null;
  }
  if (realm === 'staff' && response.status === 403 && detail === MFA_SETUP_REQUIRED_DETAIL) {
    mfaSetupListeners.forEach((listener) => listener());
  }
  return new ApiError(response.status, detail);
}

/** JSON request. Resolves to the parsed body (undefined for 204). */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options, true);
  if (!response.ok) throw await errorFrom(response, realmOf(options));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Which slice of a list endpoint to return. The API picks a default page size when `limit` is omitted. */
export interface PageParams {
  limit?: number;
  offset?: number;
}

/** One page of a list endpoint, with how many rows match its filters in all. */
export interface Page<T> {
  items: T[];
  total: number;
}

/** The largest page the staff list endpoints return. */
export const MAX_PAGE_SIZE = 200;

/** GET a paginated list: the JSON array plus its `X-Total-Count` header. */
export async function apiPage<T>(path: string, options: RequestOptions = {}): Promise<Page<T>> {
  const response = await send(path, options, true);
  if (!response.ok) throw await errorFrom(response, realmOf(options));
  const items = (await response.json()) as T[];
  const total = Number(response.headers.get('X-Total-Count') ?? Number.NaN);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

/**
 * Download a file endpoint and hand it to the browser (opens PDFs in a new tab). With `body`,
 * the file comes from a POST of that JSON.
 */
export async function downloadFile(
  path: string,
  options: { realm?: Realm; filename?: string; open?: boolean; body?: unknown } = {},
): Promise<void> {
  const realm = options.realm ?? 'staff';
  const response = await send(path, { realm, body: options.body }, true);
  if (!response.ok) throw await errorFrom(response, realm);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  if (options.open && blob.type === 'application/pdf') {
    window.open(url, '_blank', 'noopener');
  } else {
    const link = document.createElement('a');
    link.href = url;
    link.download = options.filename ?? match?.[1] ?? 'download';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Upload one file as multipart form data under the field name `file`. */
export function uploadFile<T>(path: string, file: File, options: { realm?: Realm; fields?: Record<string, string> } = {}): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(options.fields ?? {})) form.append(key, value);
  return api<T>(path, { realm: options.realm ?? 'staff', method: 'POST', body: form });
}
