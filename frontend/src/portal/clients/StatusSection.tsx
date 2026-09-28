import { useState } from 'react';
import type { ClientDetail, ClientStatus } from '../../api/clients';
import { displayFirstName } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Display';
import { ConfirmDialog } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { CLIENT_STATUS_LABELS, CLIENT_STATUS_TONES } from './clientHelpers';
import { useClientPermissions } from './clientPermissions';
import { useUpdateClient } from './EditableSection';

const STATUS_DESCRIPTIONS: Record<ClientStatus, string> = {
  active: 'Currently in care. Can use the client portal.',
  prospective: 'Considering care or waiting to start. Can use the client portal.',
  inactive: 'Not currently in care. Records stay in your list; portal sign-in is paused.',
  archived: 'Hidden from your client list and signed out of the portal. Records are kept.',
};

const ORDER: ClientStatus[] = ['active', 'prospective', 'inactive', 'archived'];

function StatusPicker({
  clientId,
  current,
  selected,
  saving,
  onSelect,
  onApply,
}: {
  clientId: number;
  current: ClientStatus;
  selected: ClientStatus;
  saving: boolean;
  onSelect: (status: ClientStatus) => void;
  onApply: () => void;
}) {
  return (
    <>
      <fieldset>
        <legend className="sr-only">Client status</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ORDER.map((status) => (
            <label
              key={status}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                selected === status ? 'border-primary-400 bg-primary-50' : 'border-sage-200 hover:bg-sage-50'
              }`}
            >
              <input
                type="radio"
                name={`client-status-${clientId}`}
                value={status}
                checked={selected === status}
                onChange={() => onSelect(status)}
                className="mt-0.5 h-4 w-4 border-sage-300 text-primary-600 focus:ring-primary-400"
              />
              <span>
                <span className="font-medium text-sage-900">{CLIENT_STATUS_LABELS[status]}</span>
                <span className="block text-xs text-sage-600">{STATUS_DESCRIPTIONS[status]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 flex justify-end">
        <Button
          onClick={onApply}
          disabled={selected === current}
          loading={saving}
          variant={selected === 'archived' ? 'danger' : 'primary'}
        >
          {selected === 'archived' ? 'Archive client' : 'Update status'}
        </Button>
      </div>
    </>
  );
}

/**
 * A client's status. Staff who may edit the profile can change it; archiving asks for
 * confirmation because it revokes portal access.
 */
export function StatusSection({ client }: { client: ClientDetail }) {
  const { editProfile } = useClientPermissions(client);
  const toast = useToast();
  const update = useUpdateClient(client.id);
  const [selected, setSelected] = useState<ClientStatus>(client.status);
  const [confirming, setConfirming] = useState(false);

  const save = (status: ClientStatus) =>
    update.mutate(
      { status },
      {
        onSuccess: (updated) => {
          setConfirming(false);
          setSelected(updated.status);
          toast.success(`${displayFirstName(updated)} is now ${CLIENT_STATUS_LABELS[updated.status].toLowerCase()}`);
        },
        onError: (error) => {
          setConfirming(false);
          toast.error(error);
        },
      },
    );

  const apply = () => (selected === 'archived' ? setConfirming(true) : save(selected));

  return (
    <Card>
      <CardHeader
        title="Status"
        actions={<Badge tone={CLIENT_STATUS_TONES[client.status]}>{CLIENT_STATUS_LABELS[client.status]}</Badge>}
      />
      <CardBody>
        {editProfile ? (
          <StatusPicker
            clientId={client.id}
            current={client.status}
            selected={selected}
            saving={update.isPending && !confirming}
            onSelect={setSelected}
            onApply={apply}
          />
        ) : (
          <p className="text-sm text-sage-600">{STATUS_DESCRIPTIONS[client.status]}</p>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirming}
        title={`Archive ${displayFirstName(client)}?`}
        danger
        confirmLabel="Archive client"
        loading={update.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => save('archived')}
        message={
          <div className="space-y-2">
            <p>
              Archiving removes {displayFirstName(client)} from your active client list and{' '}
              <strong>revokes their client portal access immediately</strong>, signing them out everywhere.
            </p>
            <p>Their chart, notes, documents and billing history are kept. You can restore them any time by changing the status.</p>
          </div>
        }
      />
    </Card>
  );
}
