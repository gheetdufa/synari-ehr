import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  FilePen,
  FileWarning,
  MessageSquare,
  Video,
} from 'lucide-react';
import type { AttentionItem } from './dashboardHelpers';

const ICONS: Record<string, typeof Video> = {
  'waiting-room': Video,
  'flagged-forms': AlertTriangle,
  requests: CalendarClock,
  messages: MessageSquare,
  'missing-notes': FileWarning,
  'draft-notes': FilePen,
  'pending-forms': ClipboardList,
};

function toneClasses(item: AttentionItem): { row: string; icon: string; count: string } {
  if (item.count === 0) {
    return { row: 'hover:bg-sage-50', icon: 'bg-sage-100 text-sage-400', count: 'text-sage-400' };
  }
  if (item.tone === 'urgent') {
    return { row: 'bg-red-50 hover:bg-red-100', icon: 'bg-red-100 text-red-700', count: 'text-red-700' };
  }
  if (item.tone === 'live') {
    return { row: 'bg-primary-50 hover:bg-primary-100', icon: 'bg-primary-600 text-white', count: 'text-primary-800' };
  }
  return { row: 'hover:bg-sage-50', icon: 'bg-primary-50 text-primary-700', count: 'text-sage-900' };
}

/** Counters for work waiting on the signed-in person; each row links to where it gets done. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <ul className="divide-y divide-sage-100">
      {items.map((item) => {
        const Icon = ICONS[item.id] ?? ClipboardList;
        const classes = toneClasses(item);
        return (
          <li key={item.id}>
            <Link
              to={item.to}
              className={`flex items-center gap-3 px-5 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400 ${classes.row}`}
            >
              <span className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${classes.icon}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.tone === 'live' && item.count > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400 ring-2 ring-white" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm font-medium ${
                    item.count > 0 && item.tone === 'urgent' ? 'text-red-800' : item.count > 0 ? 'text-sage-900' : 'text-sage-600'
                  }`}
                >
                  {item.label}
                </span>
                <span className="block truncate text-xs text-sage-500">{item.hint}</span>
              </span>
              <span className={`text-lg font-semibold tabular-nums ${classes.count}`}>{item.count}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
