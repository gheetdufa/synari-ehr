import { useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { insuranceApi, insuranceKeys, type PayerSearchResult } from '../../../api/insurance';
import { Button } from '../../../ui/Button';
import { Badge } from '../../../ui/Display';
import { Input } from '../../../ui/Form';
import { Spinner } from '../../../ui/Spinner';
import { PAYER_SUPPORT_LABELS } from '../labels';

function Support({ label, value }: { label: string; value: string }) {
  const tone = value === 'SUPPORTED' ? 'success' : value === 'ENROLLMENT_REQUIRED' ? 'warning' : 'neutral';
  return (
    <Badge tone={tone}>
      {label}: {PAYER_SUPPORT_LABELS[value] ?? value}
    </Badge>
  );
}

/** Search the clearinghouse's payer network and pick a payer's name and ID. */
export function PayerSearch({ initialQuery, onPick }: { initialQuery: string; onPick: (result: PayerSearchResult) => void }) {
  const [text, setText] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim().length >= 2 ? initialQuery.trim() : '');
  const results = useQuery({
    queryKey: insuranceKeys.payerSearch(query),
    queryFn: () => insuranceApi.searchPayers(query),
    enabled: query.length >= 2,
    staleTime: 5 * 60_000,
  });

  const search = () => setQuery(text.trim());
  // Enter searches instead of submitting the payer form this panel sits in.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (text.trim().length >= 2) search();
  };

  return (
    <div className="rounded-lg border border-sage-200 bg-sage-50/60 p-3">
      <div role="search" aria-label="Find a payer" className="flex gap-2">
        <label htmlFor="payer-search" className="sr-only">
          Payer name or ID
        </label>
        <Input
          id="payer-search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Payer name or ID, e.g. Aetna"
          autoComplete="off"
        />
        <Button variant="secondary" icon={<Search className="h-4 w-4" />} disabled={text.trim().length < 2} onClick={search}>
          Search
        </Button>
      </div>
      <div className="mt-2" aria-live="polite">
        {results.isFetching && (
          <p className="flex items-center gap-2 py-2 text-sm text-sage-600">
            <Spinner className="h-4 w-4" /> Searching the clearinghouse…
          </p>
        )}
        {results.isError && (
          <p role="alert" className="py-2 text-sm text-red-700">
            {results.error.message}
          </p>
        )}
        {results.data && results.data.length === 0 && !results.isFetching && (
          <p className="py-2 text-sm text-sage-600">No payers match “{query}”.</p>
        )}
        {results.data && results.data.length > 0 && (
          <ul className="max-h-64 divide-y divide-sage-100 overflow-y-auto rounded-lg border border-sage-100 bg-white">
            {results.data.map((result) => (
              <li key={result.stedi_id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-sage-900">{result.name}</p>
                  <p className="text-xs text-sage-500">
                    Payer ID {result.payer_id}
                    {result.aliases.length > 0 && ` · also ${result.aliases.slice(0, 3).join(', ')}`}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Support label="Claims" value={result.professional_claims} />
                    <Support label="Eligibility" value={result.eligibility} />
                    <Support label="ERA" value={result.remittances} />
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => onPick(result)} aria-label={`Use ${result.name}`}>
                  Use
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
