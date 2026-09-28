import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/** Sticky bar under the app header with the way back and the note's actions. */
export function EditorToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-16 z-10 -mx-4 -mt-6 mb-5 border-b border-sage-100 bg-sage-50/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mt-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          to="/portal/notes"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-sage-700 hover:bg-sage-100 hover:text-sage-900"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Notes
        </Link>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
    </div>
  );
}
