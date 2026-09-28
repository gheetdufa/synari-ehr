import { Flag } from 'lucide-react';
import type { FormField, ScoreFlag, ScoringSpec } from '../../api/forms';

function flagRule(flag: ScoreFlag, fields: FormField[]): string {
  const field = fields.find((candidate) => candidate.id === flag.item);
  const name = field ? `“${field.label.length > 80 ? `${field.label.slice(0, 80)}…` : field.label}”` : flag.item;
  if (flag.equals !== undefined && flag.equals !== null) {
    const option = field?.options?.find((candidate) => candidate.value === flag.equals);
    const answer = typeof flag.equals === 'boolean' ? (flag.equals ? 'Yes' : 'No') : option?.label ?? String(flag.equals);
    return `${name} answered “${answer}”`;
  }
  return `${name} scored ${flag.min ?? 0} or more`;
}

/** How a template is scored and flagged, in plain language. */
export function ScoringSummary({ scoring, fields }: { scoring: ScoringSpec; fields: FormField[] }) {
  const summed = scoring.method === 'sum' && scoring.items.length > 0;
  return (
    <div className="space-y-4 text-sm">
      {summed && (
        <div>
          <p className="text-sage-800">
            Scored automatically by adding up {scoring.items.length} answers
            {scoring.max_score !== null ? ` (0 to ${scoring.max_score})` : ''}.
          </p>
          {scoring.bands.length > 0 && (
            <ul className="mt-2 divide-y divide-sage-100 rounded-lg border border-sage-100">
              {scoring.bands.map((band) => (
                <li key={`${band.min}-${band.max}`} className="flex justify-between gap-3 px-3 py-1.5">
                  <span className="tabular-nums text-sage-600">
                    {band.min}–{band.max}
                  </span>
                  <span className="font-medium text-sage-900">{band.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {scoring.flags.length > 0 && (
        <div>
          <p className="font-medium text-sage-800">Flagged for your review when:</p>
          <ul className="mt-1 space-y-1">
            {scoring.flags.map((flag) => (
              <li key={`${flag.item}-${flag.reason}`} className="flex items-start gap-2 text-sage-700">
                <Flag aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
                <span>{flagRule(flag, fields)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
