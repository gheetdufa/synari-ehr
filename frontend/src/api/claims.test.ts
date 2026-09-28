import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimsApi, rejectedClaims } from './claims';
import { ApiError } from './client';

const client = vi.hoisted(() => ({ api: vi.fn(), downloadFile: vi.fn() }));

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, api: client.api, downloadFile: client.downloadFile };
});

describe('claim submission', () => {
  beforeEach(() => {
    client.api.mockReset().mockResolvedValue([{ id: 1, status: 'queued' }]);
    client.downloadFile.mockReset().mockResolvedValue(undefined);
  });

  it('queues claims for the clearinghouse and returns them', async () => {
    await expect(claimsApi.submit([1, 2], 'stedi')).resolves.toEqual([{ id: 1, status: 'queued' }]);
    expect(client.api).toHaveBeenCalledWith('/claims/submit', { body: { claim_ids: [1, 2], method: 'stedi' } });
    expect(client.downloadFile).not.toHaveBeenCalled();
  });

  it.each([
    ['x12_file', 'claims-837p.txt'],
    ['paper', 'cms1500-claims.pdf'],
  ] as const)('downloads the %s file instead', async (method, filename) => {
    await expect(claimsApi.submit([3], method)).resolves.toBeNull();
    expect(client.downloadFile).toHaveBeenCalledWith('/claims/submit', { body: { claim_ids: [3], method }, filename });
    expect(client.api).not.toHaveBeenCalled();
  });

  it('reads the per-claim problems from a refusal', () => {
    const claims = [{ claim_id: 1, patient_control_number: 'SYN1', issues: [{ code: 'required', field: 'payer.payer_id', message: 'x' }] }];
    expect(rejectedClaims(new ApiError(422, { message: 'Fix these claims before submitting them.', claims }))).toEqual(claims);
    expect(rejectedClaims(new ApiError(422, [{ loc: ['body', 'method'], msg: 'bad' }]))).toBeNull();
    expect(rejectedClaims(new ApiError(409, 'No clearinghouse is connected.'))).toBeNull();
    expect(rejectedClaims(new Error('offline'))).toBeNull();
  });
});
