import { useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { clientKeys, clientsApi, type ClientAccessLevel, type ClientRef, type ClientSummary } from '../../api/clients';
import { fullName, initials } from '../../lib/format';
import { Avatar, Badge } from '../../ui/Display';
import { Spinner } from '../../ui/Spinner';
import { useDebouncedValue } from './useDebouncedValue';

/** Clients a picker offers at once; typing narrows the search on the server. */
export const CLIENT_SEARCH_LIMIT = 8;
const SEARCH_DELAY_MS = 250;

/**
 * One small page of clients matching `term` (names, email or phone), searched on the server.
 * `access` keeps only clients the viewer can reach at that level (e.g. 'billing' for billing forms).
 */
export function useClientSearch(
  term: string,
  { access, limit = CLIENT_SEARCH_LIMIT, enabled = true }: { access: ClientAccessLevel; limit?: number; enabled?: boolean },
) {
  const params = { q: term || undefined, access, limit };
  return useQuery({
    queryKey: clientKeys.search(params),
    queryFn: () => clientsApi.list(params),
    select: (page) => page.items,
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 30_000,
  });
}

/** Just the reference fields, so a picked client doesn't carry a whole list row around. */
function clientRef(client: ClientRef): ClientRef {
  return { id: client.id, first_name: client.first_name, last_name: client.last_name, preferred_name: client.preferred_name };
}

/**
 * Search-as-you-type client combobox. Choosing a client hands it to `onPick` and clears the
 * search; `excludeIds` hides clients already chosen elsewhere (e.g. an appointment's participants).
 */
export function ClientCombobox({
  id,
  access,
  onPick,
  excludeIds = [],
  placeholder = 'Search clients…',
  invalid,
  disabled = false,
  inputRef,
  'aria-describedby': describedBy,
}: {
  id?: string;
  access: ClientAccessLevel;
  onPick: (client: ClientSummary) => void;
  excludeIds?: number[];
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  'aria-describedby'?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${inputId}-options`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const term = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const results = useClientSearch(term, { access, enabled: open });
  const options = (results.data ?? []).filter((client) => !excludeIds.includes(client.id));
  const searching = results.isLoading || term !== text.trim();

  // The list stays open so several clients can be added in a row (e.g. a group session).
  const choose = (client: ClientSummary) => {
    onPick(client);
    setText('');
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(options.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && open && options[active]) {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sage-400" aria-hidden="true" />
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${options[active].id}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="block h-10 w-full rounded-lg border border-sage-200 bg-white pl-9 pr-3 text-sm text-sage-900 shadow-sm placeholder:text-sage-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:bg-sage-50 aria-[invalid=true]:border-red-400"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-sage-100 bg-white py-1 text-sm shadow-lg"
        >
          {searching ? (
            <li className="flex items-center gap-2 px-3 py-2 text-sage-500">
              <Spinner className="h-4 w-4" /> Searching…
            </li>
          ) : results.isError ? (
            <li className="px-3 py-2 text-red-600">Couldn't load clients.</li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-sage-500">{term ? `No clients match “${term}”` : 'No clients to show'}</li>
          ) : (
            options.map((client, index) => (
              <li
                key={client.id}
                id={`${listId}-${client.id}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(client)}
                className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${index === active ? 'bg-primary-50' : ''}`}
              >
                <Avatar label={initials(client)} className="h-7 w-7 text-xs" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sage-900">{fullName(client)}</span>
                  {client.email && <span className="block truncate text-xs text-sage-500">{client.email}</span>}
                </span>
                {client.status !== 'active' && (
                  <Badge tone={client.status === 'prospective' ? 'info' : 'neutral'}>{client.status}</Badge>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Pick one client by searching for them. Shows the chosen client with a clear button, which
 * brings the search back.
 */
export function ClientPicker({
  value,
  onChange,
  access,
  id,
  placeholder,
  disabled = false,
  invalid,
  clearLabel = 'Clear client',
  'aria-describedby': describedBy,
}: {
  value: ClientRef | null;
  onChange: (client: ClientRef | null) => void;
  access: ClientAccessLevel;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  clearLabel?: string;
  'aria-describedby'?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  if (!value) {
    return (
      <ClientCombobox
        id={id}
        access={access}
        inputRef={input}
        placeholder={placeholder}
        disabled={disabled}
        invalid={invalid}
        aria-describedby={describedBy}
        onPick={(client) => onChange(clientRef(client))}
      />
    );
  }
  return (
    <div className="flex h-10 items-center justify-between gap-2 rounded-lg border border-sage-200 bg-white px-3 text-sm shadow-sm">
      <span id={id} className="truncate font-medium text-sage-900" aria-describedby={describedBy}>
        {fullName(value)}
      </span>
      {!disabled && (
        <button
          type="button"
          onClick={() => {
            onChange(null);
            window.setTimeout(() => input.current?.focus(), 0);
          }}
          aria-label={clearLabel}
          title={clearLabel}
          className="rounded p-0.5 text-sage-500 hover:bg-sage-100 hover:text-sage-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
