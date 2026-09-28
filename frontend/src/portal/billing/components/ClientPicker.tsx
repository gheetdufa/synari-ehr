import type { ClientRef } from '../../../api/clients';
import { fullName } from '../../../lib/format';
import { Field } from '../../../ui/Form';
import { ClientPicker as ClientSearchPicker } from '../../clients/ClientSearch';

/**
 * Client search for billing forms and filters, over the clients whose billing the signed-in
 * person sees. With `fixed`, shows that client read-only (forms opened from a client's chart or
 * an invoice).
 */
export function ClientPicker({
  value,
  onChange,
  fixed,
  label = 'Client',
  placeholder = 'Search for a client…',
  clearLabel = 'Clear client',
  error,
  required,
  className,
}: {
  value: ClientRef | null;
  onChange: (client: ClientRef | null) => void;
  fixed?: ClientRef | null;
  label?: string;
  placeholder?: string;
  clearLabel?: string;
  error?: string | null;
  required?: boolean;
  className?: string;
}) {
  if (fixed) {
    return (
      <div className={className}>
        <p className="mb-1 block text-sm font-medium text-sage-800">{label}</p>
        <p className="flex h-10 items-center rounded-lg border border-sage-100 bg-sage-50 px-3 text-sm text-sage-900">
          {fullName(fixed)}
        </p>
      </div>
    );
  }
  return (
    <Field label={label} error={error} required={required} className={className}>
      {(props) => (
        <ClientSearchPicker
          access="billing"
          id={props.id}
          aria-describedby={props['aria-describedby']}
          invalid={Boolean(error)}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          clearLabel={clearLabel}
        />
      )}
    </Field>
  );
}
