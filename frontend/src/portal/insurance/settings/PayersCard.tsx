import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building, Pencil, Plus } from 'lucide-react';
import { CLAIM_FILING_INDICATORS, insuranceApi, insuranceKeys, type Payer } from '../../../api/insurance';
import { useSession } from '../../../auth/StaffAuth';
import { Button, IconButton } from '../../../ui/Button';
import { Card, CardHeader } from '../../../ui/Card';
import { Badge, EmptyState, ErrorState, Table, Td, Th } from '../../../ui/Display';
import { Checkbox } from '../../../ui/Form';
import { ConfirmDialog } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { useAllPayers } from '../hooks';
import { PayerModal } from './PayerModal';

type Editing = { payer: Payer | null } | null;

function filingLabel(code: string): string {
  return CLAIM_FILING_INDICATORS.find((option) => option.code === code)?.label ?? code;
}

function address(payer: Payer): string {
  return [payer.address_line1, payer.city, [payer.state, payer.postal_code].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

/** The practice's payer list: add, edit, deactivate and reactivate. */
export function PayersCard({ clearinghouseEnabled }: { clearinghouseEnabled: boolean }) {
  const { capabilities } = useSession();
  const canEdit = capabilities.includes('billing_all') || capabilities.includes('manage_practice');
  const queryClient = useQueryClient();
  const toast = useToast();
  const payers = useAllPayers();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [deactivating, setDeactivating] = useState<Payer | null>(null);

  const setActive = useMutation({
    mutationFn: ({ payer, active }: { payer: Payer; active: boolean }) => insuranceApi.updatePayer(payer.id, { is_active: active }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: insuranceKeys.all });
      toast.success(saved.is_active ? `${saved.name} reactivated` : `${saved.name} deactivated`);
      setDeactivating(null);
    },
    onError: (error) => {
      toast.error(error);
      setDeactivating(null);
    },
  });

  const all = payers.data ?? [];
  const inactiveCount = all.filter((payer) => !payer.is_active).length;
  const shown = showInactive ? all : all.filter((payer) => payer.is_active);

  return (
    <Card>
      <CardHeader
        title="Payers"
        description="Insurance companies you bill. Each client policy is linked to one of these."
        actions={
          canEdit && (
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ payer: null })}>
              Add payer
            </Button>
          )
        }
      />
      {payers.isPending && <SectionSpinner />}
      {payers.isError && <ErrorState error={payers.error} onRetry={() => void payers.refetch()} />}
      {payers.data && all.length === 0 && (
        <EmptyState
          icon={<Building />}
          title="No payers yet"
          description={
            clearinghouseEnabled
              ? 'Add the insurance companies you bill. Use Find payer to fill in the clearinghouse payer ID.'
              : 'Add the insurance companies you bill, with the payer ID your clearinghouse uses.'
          }
        />
      )}
      {all.length > 0 && (
        <>
          {inactiveCount > 0 && (
            <div className="border-b border-sage-100 px-5 py-2">
              <Checkbox
                label={`Show inactive payers (${inactiveCount})`}
                checked={showInactive}
                onChange={(event) => setShowInactive(event.target.checked)}
              />
            </div>
          )}
          <Table>
            <thead className="bg-sage-50/60">
              <tr>
                <Th>Name</Th>
                <Th>Payer ID</Th>
                <Th className="hidden md:table-cell">Insurance type</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sage-100">
              {shown.map((payer) => (
                <tr key={payer.id} className={payer.is_active ? '' : 'bg-sage-50/50'}>
                  <Td>
                    <p className="flex flex-wrap items-center gap-2 font-medium text-sage-900">
                      {payer.name}
                      {!payer.is_active && <Badge>Inactive</Badge>}
                      {payer.era_enrolled && <Badge tone="info">ERA</Badge>}
                    </p>
                    {address(payer) && <p className="text-xs text-sage-500">{address(payer)}</p>}
                  </Td>
                  <Td className="font-mono text-xs">
                    {payer.external_id || <span className="font-sans text-sage-500">Paper only</span>}
                  </Td>
                  <Td className="hidden md:table-cell">{filingLabel(payer.claim_filing_indicator)}</Td>
                  <Td className="text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <IconButton label={`Edit ${payer.name}`} onClick={() => setEditing({ payer })}>
                          <Pencil className="h-4 w-4" />
                        </IconButton>
                        {payer.is_active ? (
                          <Button size="sm" variant="ghost" onClick={() => setDeactivating(payer)}>
                            Deactivate
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={setActive.isPending && setActive.variables?.payer.id === payer.id}
                            onClick={() => setActive.mutate({ payer, active: true })}
                          >
                            Reactivate
                          </Button>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {editing && (
        <PayerModal payer={editing.payer} clearinghouseEnabled={clearinghouseEnabled} onClose={() => setEditing(null)} />
      )}
      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate payer?"
        confirmLabel="Deactivate"
        loading={setActive.isPending}
        onCancel={() => setDeactivating(null)}
        onConfirm={() => deactivating && setActive.mutate({ payer: deactivating, active: false })}
        message={
          deactivating && (
            <p>
              <strong>{deactivating.name}</strong> won&apos;t be offered for new policies. Existing policies and claims keep
              it, and you can reactivate it any time.
            </p>
          )
        }
      />
    </Card>
  );
}
