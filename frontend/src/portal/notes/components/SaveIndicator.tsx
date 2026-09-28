import { useEffect, useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import type { AutosaveStatus } from '../autosave';
import { Spinner } from '../../../ui/Spinner';

const TICK_MS = 30_000;

function savedLabel(lastSavedAt: number | null, now: number): string {
  if (lastSavedAt === null) return 'All changes saved';
  const minutes = Math.floor((now - lastSavedAt) / 60_000);
  if (minutes < 1) return 'Saved just now';
  if (minutes < 60) return `Saved ${minutes} min ago`;
  return 'All changes saved';
}

/** "Saving… / Saved just now / Unsaved changes / Couldn't save" for the draft editor. */
export function SaveIndicator({
  status,
  lastSavedAt,
  onRetry,
}: {
  status: AutosaveStatus;
  lastSavedAt: number | null;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setNow(Date.now()), [lastSavedAt]);

  return (
    <div aria-live="polite" className="flex items-center gap-1.5 whitespace-nowrap text-sm">
      {status === 'saving' && (
        <span className="flex items-center gap-1.5 text-sage-600">
          <Spinner className="h-3.5 w-3.5" /> Saving…
        </span>
      )}
      {status === 'dirty' && <span className="text-sage-600">Unsaved changes</span>}
      {status === 'saved' && (
        <span className="flex items-center gap-1 text-sage-600">
          <Check className="h-4 w-4 text-primary-600" aria-hidden="true" /> {savedLabel(lastSavedAt, now)}
        </span>
      )}
      {status === 'error' && (
        <span className="flex items-center gap-1.5 text-red-700">
          <AlertCircle className="h-4 w-4" aria-hidden="true" /> Couldn't save
          <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2 hover:text-red-900">
            Retry
          </button>
        </span>
      )}
    </div>
  );
}
