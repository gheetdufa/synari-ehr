import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mfaApi } from '../api/auth';
import { MfaSetupForm } from './MfaSetup';

vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;base64,AAAA') } }));

const SETUP = { secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/Synari:dana?secret=JBSWY3DPEHPK3PXP' };

function renderSetup() {
  return render(
    <StrictMode>
      <MfaSetupForm onDone={() => undefined} />
    </StrictMode>,
  );
}

describe('MfaSetupForm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts one setup per mount, even when StrictMode runs effects twice', async () => {
    const setup = vi.spyOn(mfaApi, 'setup').mockResolvedValue(SETUP);
    const first = renderSetup();
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeInTheDocument();
    expect(setup).toHaveBeenCalledTimes(1);

    first.unmount();
    renderSetup();
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    expect(setup).toHaveBeenCalledTimes(2);
  });

  it('shows why setup could not start', async () => {
    vi.spyOn(mfaApi, 'setup').mockRejectedValue(new Error('Two-factor authentication is already on'));
    renderSetup();
    expect(await screen.findByText('Two-factor authentication is already on')).toBeInTheDocument();
  });
});
