import { Settings, Sparkles, UserPlus } from 'lucide-react';
import { LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';

/** Shown until the practice has its first client: the two things to do next. */
export function FirstRunCard() {
  return (
    <Card className="overflow-hidden border-primary-100 bg-gradient-to-br from-primary-50 via-white to-white">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-white">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-sage-900">Welcome to your practice</h2>
          <p className="mt-1 text-sm text-sage-600">
            Add your first client to start scheduling, messaging and sharing intake forms. Setting your services,
            rates and availability first lets clients request appointments online.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton to="/portal/clients?new=1" icon={<UserPlus className="h-4 w-4" />}>
            Add a client
          </LinkButton>
          <LinkButton to="/portal/settings?welcome=1" variant="secondary" icon={<Settings className="h-4 w-4" />}>
            Set up practice
          </LinkButton>
        </div>
      </div>
    </Card>
  );
}
