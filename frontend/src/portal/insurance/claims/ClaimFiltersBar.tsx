import { useState } from 'react';
import type { ClaimFilters } from '../../../api/claims';
import type { ClientRef } from '../../../api/clients';
import { Button } from '../../../ui/Button';
import { Field, Input, Select } from '../../../ui/Form';
import { ClientPicker } from '../../clients/ClientSearch';
import { useAllPayers, useClinicians } from '../hooks';

function idFrom(value: string): number | undefined {
  return value ? Number(value) : undefined;
}

/** Clinician, payer, client and date-of-service filters shared by the queue and the claims list. */
export function ClaimFiltersBar({ value, onChange }: { value: ClaimFilters; onChange: (next: ClaimFilters) => void }) {
  const clinicians = useClinicians();
  const payers = useAllPayers();
  // The filter keeps only the id; remember the picked client to show their name.
  const [picked, setPicked] = useState<ClientRef | null>(null);
  const client = picked && picked.id === value.client_id ? picked : null;
  const set = (patch: ClaimFilters) => onChange({ ...value, ...patch });
  const active = Object.values(value).some((entry) => entry !== undefined && entry !== '');

  return (
    <div className="grid grid-cols-2 gap-3 border-b border-sage-100 px-4 py-3 sm:px-5 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] [&>*]:min-w-0">
      <Field label="Clinician">
        {(props) => (
          <Select {...props} value={value.clinician_id ?? ''} onChange={(e) => set({ clinician_id: idFrom(e.target.value) })}>
            <option value="">All clinicians</option>
            {(clinicians.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.display_name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Payer">
        {(props) => (
          <Select {...props} value={value.payer_id ?? ''} onChange={(e) => set({ payer_id: idFrom(e.target.value) })}>
            <option value="">All payers</option>
            {(payers.data ?? []).map((payer) => (
              <option key={payer.id} value={payer.id}>
                {payer.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Client" className="col-span-2 lg:col-span-1">
        {(props) => (
          <ClientPicker
            access="billing"
            id={props.id}
            value={client}
            placeholder="All clients"
            clearLabel="Show all clients"
            onChange={(next) => {
              setPicked(next);
              set({ client_id: next?.id });
            }}
          />
        )}
      </Field>
      <Field label="Service from">
        {(props) => (
          <Input {...props} type="date" value={value.start ?? ''} onChange={(e) => set({ start: e.target.value || undefined })} />
        )}
      </Field>
      <Field label="Service to">
        {(props) => (
          <Input {...props} type="date" value={value.end ?? ''} onChange={(e) => set({ end: e.target.value || undefined })} />
        )}
      </Field>
      <div className="col-span-2 flex items-end justify-end lg:col-span-1">
        <Button variant="ghost" onClick={() => onChange({})} disabled={!active}>
          Clear
        </Button>
      </div>
    </div>
  );
}
