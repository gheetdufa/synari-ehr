import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, tokenStore } from './client';
import { importsApi, uploadImportFile, type ImportJob } from './imports';

const JOB = { id: 7, status: 'uploaded', files: [] } as unknown as ImportJob;

/** An access token that won't be refreshed during the test. */
function accessToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

/** A stand-in XMLHttpRequest that records what was sent and lets the test answer it. */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  responseText = '';
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

/** Resolves once the upload has been sent (the token lookup is asynchronous). */
async function sentRequest(): Promise<FakeXhr> {
  await vi.waitFor(() => expect(FakeXhr.last?.body).not.toBeNull());
  return FakeXhr.last!;
}

describe('uploadImportFile', () => {
  beforeEach(() => {
    FakeXhr.last = null;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    tokenStore.set('staff', { access_token: accessToken(), refresh_token: 'refresh', expires_in: 3600 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear('staff');
  });

  it('sends the file and its kind with the bearer token and reports progress', async () => {
    const progress: number[] = [];
    const file = new File(['Client,Email\n'], 'clients.csv', { type: 'text/csv' });
    const pending = uploadImportFile(7, file, { kind: 'client_details', onProgress: (fraction) => progress.push(fraction) });
    const request = await sentRequest();

    expect(request.method).toBe('POST');
    expect(request.url).toMatch(/\/imports\/7\/files$/);
    expect(request.headers.Authorization).toMatch(/^Bearer header\./);
    expect((request.body!.get('file') as File).name).toBe('clients.csv');
    expect(request.body!.get('kind')).toBe('client_details');

    request.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 });
    request.respond(201, JOB);
    await expect(pending).resolves.toEqual(JOB);
    expect(progress).toEqual([0.25, 1]);
  });

  it('leaves the kind out when the server should detect it', async () => {
    const pending = uploadImportFile(7, new File(['PK'], 'export.zip'));
    const request = await sentRequest();
    expect(request.body!.has('kind')).toBe(false);
    request.respond(201, JOB);
    await pending;
  });

  it("rejects with the server's message", async () => {
    const pending = uploadImportFile(7, new File(['x'], 'huge.zip'));
    const request = await sentRequest();
    request.respond(413, { detail: 'Import files must be under 2048 MB' });
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(413);
    expect((error as ApiError).message).toBe('Import files must be under 2048 MB');
  });
});

describe('importsApi', () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify(JOB), { status: 200 })),
  );

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    tokenStore.set('staff', { access_token: accessToken(), refresh_token: 'refresh', expires_in: 3600 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear('staff');
  });

  it('patches file kinds, the mapping and the zip password as JSON', async () => {
    await importsApi.update(7, {
      files: [{ file_id: 3, kind: 'attendance' }],
      mapping: { '3': { client: 'Client name', location: null } },
      zip_password: 'secret',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/imports\/7$/);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({
      files: [{ file_id: 3, kind: 'attendance' }],
      mapping: { '3': { client: 'Client name', location: null } },
      zip_password: 'secret',
    });
  });

  it.each([
    ['analyze', '/imports/7/analyze'],
    ['start', '/imports/7/start'],
    ['cancel', '/imports/7/cancel'],
  ] as const)('%s posts to its endpoint', async (action, path) => {
    await importsApi[action](7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.endsWith(path)).toBe(true);
    expect(init?.method).toBe('POST');
  });

  it('creates an import and removes files', async () => {
    await importsApi.create();
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({});
    await importsApi.removeFile(7, 3);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/imports\/7\/files\/3$/);
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE');
  });
});
