import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ClientSummary } from '../../api/clients';
import { fullName, initials } from '../../lib/format';
import { Avatar, Badge, ErrorState } from '../../ui/Display';
import { Input } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useClientSearch } from '../clients/ClientSearch';
import { useDebouncedValue } from '../clients/useDebouncedValue';

const SEARCH_DEBOUNCE_MS = 250;
/** Clients listed at once; searching narrows it on the server. */
const RESULT_LIMIT = 20;

function ClientResults({ search, onSelect }: { search: string; onSelect: (client: ClientSummary) => void }) {
  const results = useClientSearch(search, { access: 'clinical', limit: RESULT_LIMIT });
  if (results.isLoading) return <SectionSpinner />;
  if (results.error) return <ErrorState error={results.error} onRetry={() => void results.refetch()} />;
  if (!results.data?.length) {
    return (
      <p className="py-8 text-center text-sm text-sage-500">
        {search ? `No clients match “${search}”.` : 'Add a client to start messaging.'}
      </p>
    );
  }
  return (
    <ul className="-mx-2 max-h-80 space-y-0.5 overflow-y-auto" aria-label="Clients">
      {results.data.map((client) => (
        <li key={client.id}>
          <button
            type="button"
            onClick={() => onSelect(client)}
            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-sage-50 focus:bg-sage-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          >
            <Avatar label={initials(client)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-sage-900">{fullName(client)}</span>
              {client.email && <span className="block truncate text-xs text-sage-500">{client.email}</span>}
            </span>
            {client.status !== 'active' && <Badge>{client.status === 'prospective' ? 'Prospective' : 'Inactive'}</Badge>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Pick a client to message; opens (or starts) that client's thread. */
export function NewMessageDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (clientId: number) => void;
}) {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setSearch('');
      return;
    }
    // The dialog focuses its first control when it opens; move focus to the search box after that.
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="New message" description="Choose a client to message securely.">
      <div className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sage-400" aria-hidden="true" />
          <Input
            ref={inputRef}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search clients by name, email or phone"
            aria-label="Search clients"
            className="pl-9"
          />
        </div>
        {open && <ClientResults search={debounced} onSelect={(client) => onSelect(client.id)} />}
      </div>
    </Modal>
  );
}
