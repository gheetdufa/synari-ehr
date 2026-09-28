import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth/StaffAuth';
import { EmptyState } from '../ui/Display';
import { canOpenArea } from './navigation';

/**
 * Shows an area only to roles its sidebar link is shown to (the API enforces the same rules),
 * so a typed or bookmarked URL doesn't open an empty screen full of access errors.
 */
export function AreaGate({ area, children }: { area: string; children: ReactNode }) {
  const session = useSession();
  if (canOpenArea(session, area)) return <>{children}</>;
  return (
    <EmptyState
      icon={<Lock />}
      title="Not available for your role"
      description="Ask a practice owner or manager if you need access to this area."
      action={
        <Link to="/portal" className="text-sm font-medium text-primary-700 hover:underline">
          Back to the dashboard
        </Link>
      }
    />
  );
}
