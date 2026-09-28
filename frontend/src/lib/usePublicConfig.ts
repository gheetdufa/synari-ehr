import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchPublicConfig, type PublicConfig } from '../api/auth';
import { setDisplayCurrency } from './format';

const OFFLINE_DEFAULTS: PublicConfig = {
  registration_enabled: true,
  email_enabled: false,
  sms_enabled: false,
  payments_enabled: false,
  telehealth_enabled: false,
  ai_enabled: false,
  livekit_url: '',
  currency: 'USD',
};

/** Which optional integrations the server has (payments, telehealth, AI, SMS...). */
export function usePublicConfig(): PublicConfig {
  const { data } = useQuery({ queryKey: ['config'], queryFn: fetchPublicConfig, staleTime: 5 * 60_000 });
  const config = data ?? OFFLINE_DEFAULTS;
  useEffect(() => setDisplayCurrency(config.currency), [config.currency]);
  return config;
}
