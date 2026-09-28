import { useId } from 'react';
import { X } from 'lucide-react';
import { MAX_PARTICIPANTS } from '../../api/appointments';
import { formatMoney, initials } from '../../lib/format';
import { Avatar } from '../../ui/Display';
import { ClientCombobox } from '../clients/ClientSearch';
import type { ParticipantValue } from './appointmentForm';

/** "AR" from "Alex Rivera". */
function nameInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return initials({ first_name: words[0] ?? '', last_name: words.length > 1 ? words[words.length - 1] : '' });
}

/**
 * The clients in an appointment as removable chips (1 to 15), with a search to add more. In a
 * couples or family session one client is billed (the identified patient); in a group everyone is.
 */
export function ParticipantsField({
  id,
  participants,
  group,
  feeFor,
  invalid,
  describedBy,
  onAdd,
  onRemove,
  onBill,
}: {
  id: string;
  participants: ParticipantValue[];
  group: boolean;
  /** A client's current fee when it's known (an existing appointment), else null. */
  feeFor: (participant: ParticipantValue) => number | null;
  invalid?: boolean;
  describedBy?: string;
  onAdd: (client: { id: number; name: string }) => void;
  onRemove: (clientId: number) => void;
  onBill: (clientId: number) => void;
}) {
  const billingName = useId();
  const shared = participants.length > 1;
  const full = participants.length >= MAX_PARTICIPANTS;

  return (
    <div className="space-y-2">
      {participants.length > 0 && (
        <ul className="space-y-1.5" aria-label="Clients in this appointment">
          {participants.map((participant) => {
            const fee = participant.billable ? feeFor(participant) : null;
            return (
              <li
                key={participant.clientId}
                className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-sage-200 bg-white px-2 py-1.5 shadow-sm"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Avatar label={nameInitials(participant.name)} className="h-6 w-6 text-[10px]" />
                  <span className="truncate text-sm font-medium text-sage-900">{participant.name}</span>
                </span>
                {shared && !group ? (
                  <label className="flex items-center gap-1.5 text-xs text-sage-700">
                    <input
                      type="radio"
                      name={billingName}
                      checked={participant.billable}
                      onChange={() => onBill(participant.clientId)}
                      aria-label={`Bill ${participant.name} (identified patient)`}
                      className="h-3.5 w-3.5 border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
                    />
                    {participant.billable ? 'Billed' : 'Not billed'}
                  </label>
                ) : (
                  shared && <span className="text-xs text-sage-600">{participant.billable ? 'Billed' : 'Not billed'}</span>
                )}
                {fee !== null && <span className="text-xs tabular-nums text-sage-600">{formatMoney(fee)}</span>}
                <button
                  type="button"
                  onClick={() => onRemove(participant.clientId)}
                  aria-label={`Remove ${participant.name}`}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-sage-500 hover:bg-sage-100 hover:text-sage-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {full ? (
        <p className="text-xs text-sage-500">An appointment can have up to {MAX_PARTICIPANTS} clients.</p>
      ) : (
        <ClientCombobox
          id={id}
          access="profile"
          excludeIds={participants.map((participant) => participant.clientId)}
          placeholder={participants.length === 0 ? 'Search clients by name, email or phone' : 'Add another client'}
          invalid={invalid}
          aria-describedby={describedBy}
          onPick={(client) => onAdd({ id: client.id, name: `${client.first_name} ${client.last_name}` })}
        />
      )}
    </div>
  );
}
