import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys, todayInZone } from '../../api/billing';
import { clientKeys } from '../../api/clients';
import { useCan, useSession } from '../../auth/StaffAuth';
import { useRealtimeEvent } from '../../lib/realtime';

/** Refetch everything billing-related (and the affected client's record, for AutoPay). */
export function useInvalidateBilling(): (clientId?: number) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (clientId?: number) => {
      const pending = [queryClient.invalidateQueries({ queryKey: billingKeys.all })];
      if (clientId !== undefined) pending.push(queryClient.invalidateQueries({ queryKey: clientKeys.detail(clientId) }));
      await Promise.all(pending);
    },
    [queryClient],
  );
}

/** Keep billing screens current when payments, webhooks or AutoPay change a client's billing. */
export function useBillingRealtime(): void {
  const invalidate = useInvalidateBilling();
  useRealtimeEvent('billing.changed', (event) => {
    const clientId = event.data.client_id;
    void invalidate(typeof clientId === 'number' ? clientId : undefined);
  });
}

/**
 * Whose billing the signed-in person sees: every client's (`billing_all`), or only the clients
 * on their own care team (`billing_own`), which billing screens call "your clients".
 */
export function useBillingScope(): 'practice' | 'own' {
  return useCan('billing_all') ? 'practice' : 'own';
}

/** The practice's time zone and today's date there (YYYY-MM-DD). */
export function usePracticeDay(): { timeZone: string; today: string } {
  const { practice } = useSession();
  return { timeZone: practice.time_zone, today: todayInZone(practice.time_zone) };
}
