import { useId, type ReactNode } from 'react';

export interface RadioCardOption<T extends string> {
  id: T;
  label: ReactNode;
  description: ReactNode;
}

/** A labelled group of radio buttons shown as cards, each with a one-line explanation. */
export function RadioCards<T extends string>({
  legend,
  options,
  value,
  onChange,
  hint,
}: {
  legend: ReactNode;
  options: RadioCardOption<T>[];
  value: T;
  onChange: (value: T) => void;
  hint?: ReactNode;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 block text-sm font-medium text-sage-800">{legend}</legend>
      {hint && <p className="mb-2 text-xs text-sage-500">{hint}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors has-[:disabled]:cursor-default ${
              value === option.id ? 'border-primary-400 bg-primary-50' : 'border-sage-200 hover:bg-sage-50'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
              className="mt-0.5 h-4 w-4 border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
            />
            <span>
              <span className="font-medium text-sage-900">{option.label}</span>
              <span className="block text-xs text-sage-600">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
