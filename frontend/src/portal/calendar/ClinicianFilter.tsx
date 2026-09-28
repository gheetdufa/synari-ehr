import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { Popover } from '../../ui/Display';
import { selectedClinicians, type CalendarClinician, type ClinicianSelection } from './clinicians';

/** A clinician's color dot. */
export function ClinicianDot({ color, className = 'h-2.5 w-2.5' }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={`inline-block shrink-0 rounded-full ${color} ${className}`} />;
}

/** "Everyone" when every clinician is ticked, so people who join later show up too. */
function normalized(ids: number[], clinicians: CalendarClinician[]): ClinicianSelection {
  return clinicians.every((clinician) => ids.includes(clinician.id)) ? 'all' : ids;
}

/** Which clinicians' calendars to show, each with their color. At least one stays selected. */
export function ClinicianFilter({
  clinicians,
  selection,
  myId,
  onChange,
}: {
  clinicians: CalendarClinician[];
  selection: ClinicianSelection;
  /** The signed-in person's id when they're a clinician (offers "Only me"). */
  myId: number | null;
  onChange: (selection: ClinicianSelection) => void;
}) {
  const legendId = useId();
  const shown = selectedClinicians(selection, clinicians);
  const summary =
    selection === 'all' ? 'All clinicians' : shown.length === 1 ? shown[0].name : `${shown.length} clinicians`;
  const ids = shown.map((clinician) => clinician.id);

  const toggle = (id: number, checked: boolean) => {
    const next = checked ? [...ids, id] : ids.filter((item) => item !== id);
    if (next.length > 0) onChange(normalized(next, clinicians));
  };

  return (
    <Popover
      align="left"
      className="w-72 max-w-[calc(100vw-2rem)]"
      trigger={({ open, toggle: toggleOpen }) => (
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`Clinicians shown: ${summary}`}
          className="inline-flex h-8 max-w-[16rem] items-center gap-2 rounded-lg border border-sage-200 bg-white px-3 text-sm font-medium text-sage-800 shadow-sm hover:bg-sage-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        >
          <span className="flex -space-x-1">
            {shown.slice(0, 4).map((clinician) => (
              <ClinicianDot key={clinician.id} color={clinician.color} className="h-3 w-3 ring-2 ring-white" />
            ))}
          </span>
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-sage-500" aria-hidden="true" />
        </button>
      )}
    >
      {() => (
        <div role="group" aria-labelledby={legendId} className="p-2">
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
            <p id={legendId} className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-sage-500">
              Show calendars
            </p>
            <div className="flex gap-1">
              {myId !== null && clinicians.some((clinician) => clinician.id === myId) && (
                <button
                  type="button"
                  onClick={() => onChange([myId])}
                  className="whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium text-primary-700 hover:bg-primary-50"
                >
                  Only me
                </button>
              )}
              <button
                type="button"
                onClick={() => onChange('all')}
                className="rounded px-1.5 py-0.5 text-xs font-medium text-primary-700 hover:bg-primary-50"
              >
                Everyone
              </button>
            </div>
          </div>
          <ul className="max-h-72 space-y-0.5 overflow-y-auto">
            {clinicians.map((clinician) => {
              const checked = ids.includes(clinician.id);
              return (
                <li key={clinician.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-sage-800 hover:bg-sage-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={checked && ids.length === 1}
                      onChange={(event) => toggle(clinician.id, event.target.checked)}
                      className="h-4 w-4 rounded border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
                    />
                    <ClinicianDot color={clinician.color} />
                    <span className="truncate">
                      {clinician.name}
                      {clinician.id === myId && <span className="text-sage-500"> (you)</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Popover>
  );
}
