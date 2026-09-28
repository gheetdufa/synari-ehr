import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LogOut, Monitor, Smartphone } from 'lucide-react';
import { securityApi, securityKeys, type AuthSession } from '../../../api/security';
import { useSession, useStaffAuth } from '../../../auth/StaffAuth';
import { formatDate, timeAgo } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card, CardBody, CardHeader } from '../../../ui/Card';
import { Badge, ErrorState } from '../../../ui/Display';
import { ConfirmDialog } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { isMobileDevice } from './securityText';

function SessionRow({
  session,
  timeZone,
  signingOut,
  onSignOut,
}: {
  session: AuthSession;
  timeZone: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const Icon = isMobileDevice(session.device, session.user_agent) ? Smartphone : Monitor;
  const details = [
    session.current ? 'Active now' : `Last active ${timeAgo(session.last_seen_at)}`,
    session.ip_address,
    `Signed in ${formatDate(session.created_at, timeZone)}`,
  ].filter(Boolean);
  return (
    <li className="flex items-center gap-3 px-5 py-3 text-sm">
      <Icon className="h-5 w-5 shrink-0 text-sage-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium text-sage-900">
          <span title={session.user_agent || undefined}>{session.device || 'Unknown device'}</span>
          {session.current && <Badge tone="success">This device</Badge>}
        </p>
        <p className="text-xs text-sage-500">{details.join(' · ')}</p>
      </div>
      {!session.current && (
        <Button
          variant="secondary"
          size="sm"
          loading={signingOut}
          aria-label={`Sign out ${session.device || 'this device'}`}
          onClick={onSignOut}
        >
          Sign out
        </Button>
      )}
    </li>
  );
}

/** Devices signed in to your account: sign out any of them, or every device at once. */
export function SessionsCard() {
  const { staff } = useSession();
  const { logoutEverywhere } = useStaffAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({ queryKey: securityKeys.sessions, queryFn: securityApi.sessions });
  const [confirming, setConfirming] = useState(false);

  const revoke = useMutation({
    mutationFn: (session: AuthSession) => securityApi.revokeSession(session.id),
    onSuccess: (_result, session) => {
      void queryClient.invalidateQueries({ queryKey: securityKeys.sessions });
      toast.success(`Signed out ${session.device || 'that device'}`);
    },
    onError: (error) => toast.error(error),
  });

  const everywhere = useMutation({
    mutationFn: logoutEverywhere,
    onSuccess: () => navigate('/login', { replace: true }),
    onError: (error) => {
      setConfirming(false);
      toast.error(error);
    },
  });

  return (
    <Card>
      <CardHeader title="Your sessions" description="Devices signed in to your account. Sign out any you don't recognize." />
      {sessions.isPending && <SectionSpinner />}
      {sessions.isError && <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />}
      {sessions.data && sessions.data.length > 0 && (
        <ul className="divide-y divide-sage-100 border-b border-sage-100">
          {sessions.data.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              timeZone={staff.time_zone}
              signingOut={revoke.isPending && revoke.variables?.id === session.id}
              onSignOut={() => revoke.mutate(session)}
            />
          ))}
        </ul>
      )}
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-sage-600">
          Signed in on a shared or lost device? Sign out everywhere, then sign in again here.
        </p>
        <Button variant="secondary" icon={<LogOut className="h-4 w-4" />} onClick={() => setConfirming(true)}>
          Sign out everywhere
        </Button>
      </CardBody>
      <ConfirmDialog
        open={confirming}
        title="Sign out everywhere?"
        message="Every device signed in to your account, including this one, will be signed out right away."
        confirmLabel="Sign out everywhere"
        danger
        loading={everywhere.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => everywhere.mutate()}
      />
    </Card>
  );
}
