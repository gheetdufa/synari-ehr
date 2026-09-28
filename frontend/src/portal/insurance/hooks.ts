import { useQuery, useQueryClient } from '@tanstack/react-query';
import { claimsKeys } from '../../api/claims';
import { insuranceApi, insuranceKeys } from '../../api/insurance';
import { remittanceKeys } from '../../api/remittances';
import { teamApi, teamKeys } from '../../api/team';
import { useRealtimeEvent } from '../../lib/realtime';

/** Keep claim and remittance screens current when claims or insurance payments change. */
export function useClaimsRealtime(): void {
  const queryClient = useQueryClient();
  useRealtimeEvent('claims.changed', (event) => {
    if (Array.isArray(event.data.claim_ids)) void queryClient.invalidateQueries({ queryKey: claimsKeys.all });
    if (Array.isArray(event.data.remittance_ids)) void queryClient.invalidateQueries({ queryKey: remittanceKeys.all });
  });
}

/** The practice's claim options and whether a clearinghouse is connected. */
export function useInsuranceSettings() {
  return useQuery({ queryKey: insuranceKeys.settings, queryFn: insuranceApi.settings });
}

/** The payer list, inactive payers included (for filters and existing records). */
export function useAllPayers() {
  return useQuery({ queryKey: insuranceKeys.payers(true), queryFn: () => insuranceApi.payers(true) });
}

/** Active clinicians on the team, for pickers and filters. */
export function useClinicians() {
  return useQuery({
    queryKey: teamKeys.members,
    queryFn: teamApi.list,
    select: (members) => members.filter((member) => member.is_clinician && member.status === 'active'),
  });
}

