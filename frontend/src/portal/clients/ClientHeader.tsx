import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  CalendarPlus,
  ChevronLeft,
  FilePlus2,
  Globe,
  Mail,
  MessageSquare,
  Phone,
  Send,
  Stethoscope,
} from 'lucide-react';
import { clientsApi, type ClientDetail } from '../../api/clients';
import { useSession } from '../../auth/StaffAuth';
import { formatDateTime, formatPlainDate, fullName, initials, timeAgo } from '../../lib/format';
import { Button, LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Avatar, Badge } from '../../ui/Display';
import { useToast } from '../../ui/Toast';
import { staffClientMessagesPath } from '../../shared/messages/links';
import { CLIENT_STATUS_LABELS, CLIENT_STATUS_TONES, ageOn, portalOpen, todayIn } from './clientHelpers';
import { primaryClinician, useClientPermissions } from './clientPermissions';
import { ExportRecordButton } from './ExportRecordDialog';

/** What the client's portal access looks like right now, in one line. */
export function portalStatusText(client: ClientDetail): string {
  if (!client.portal_enabled) return 'Portal access is off';
  if (client.status === 'inactive' || client.status === 'archived') {
    return `Portal paused while ${CLIENT_STATUS_LABELS[client.status].toLowerCase()}`;
  }
  if (!client.email) return 'Add an email address to invite them to the portal';
  if (client.portal_last_login_at) return `Last portal sign-in ${timeAgo(client.portal_last_login_at)}`;
  return "Hasn't signed in to the portal yet";
}

export function canInviteToPortal(client: ClientDetail): boolean {
  return portalOpen(client) && Boolean(client.email);
}

/**
 * The chart header: who the client is, their clinician, portal status and quick actions for this
 * role. `emergencyAccess`: the chart is open through an emergency access grant (clinicians only
 * get one for a chart they couldn't open), which doesn't cover exporting the record.
 */
export function ClientHeader({ client, emergencyAccess }: { client: ClientDetail; emergencyAccess: boolean }) {
  const { staff } = useSession();
  const permissions = useClientPermissions(client);
  const toast = useToast();
  const invite = useMutation({
    mutationFn: () => clientsApi.invite(client.id),
    onSuccess: (result) => toast.success(result.detail),
    onError: (error) => toast.error(error),
  });
  const today = todayIn(staff.time_zone);
  const primary = primaryClinician(client.care_team);

  return (
    <div className="mb-6">
      <Link
        to="/portal/clients"
        className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-sage-600 hover:text-sage-900"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Clients
      </Link>
      <Card className="p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-4">
            <Avatar label={initials(client)} className="h-14 w-14 text-lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="text-2xl font-semibold tracking-tight text-sage-900">{fullName(client)}</h1>
                {client.pronouns && <span className="text-sm text-sage-500">{client.pronouns}</span>}
                <Badge tone={CLIENT_STATUS_TONES[client.status]}>{CLIENT_STATUS_LABELS[client.status]}</Badge>
                {client.is_minor && <Badge tone="info">Minor</Badge>}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-sage-600">
                {client.date_of_birth && (
                  <li>
                    {ageOn(client.date_of_birth, today)} years old · born {formatPlainDate(client.date_of_birth)}
                  </li>
                )}
                {primary && (
                  <li className="flex items-center gap-1.5">
                    <Stethoscope className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
                    <span>
                      <span className="sr-only">Primary clinician: </span>
                      {primary.name}
                    </span>
                  </li>
                )}
                {client.email && (
                  <li className="flex min-w-0 items-center gap-1.5">
                    <Mail className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
                    <a href={`mailto:${client.email}`} className="truncate hover:text-primary-700 hover:underline">
                      {client.email}
                    </a>
                  </li>
                )}
                {client.phone && (
                  <li className="flex items-center gap-1.5">
                    <Phone className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
                    <a href={`tel:${client.phone}`} className="hover:text-primary-700 hover:underline">
                      {client.phone}
                    </a>
                  </li>
                )}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span
                  className="flex items-center gap-1.5 text-sage-600"
                  title={
                    client.portal_last_login_at ? formatDateTime(client.portal_last_login_at, staff.time_zone) : undefined
                  }
                >
                  <Globe className="h-4 w-4 text-sage-400" aria-hidden="true" />
                  {portalStatusText(client)}
                </span>
                {permissions.editProfile && canInviteToPortal(client) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Send className="h-3.5 w-3.5" />}
                    loading={invite.isPending}
                    onClick={() => invite.mutate()}
                  >
                    {client.portal_last_login_at ? 'Resend portal invite' : 'Send portal invite'}
                  </Button>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:shrink-0 lg:justify-end">
            {permissions.clinical && (
              <LinkButton
                to={staffClientMessagesPath(client.id)}
                variant="secondary"
                size="sm"
                icon={<MessageSquare className="h-4 w-4" />}
              >
                Message
              </LinkButton>
            )}
            {permissions.schedule && (
              <LinkButton
                to={`/portal/calendar?new=1&client=${client.id}`}
                variant="secondary"
                size="sm"
                icon={<CalendarPlus className="h-4 w-4" />}
              >
                Schedule
              </LinkButton>
            )}
            {permissions.clinical && (
              <LinkButton to={`/portal/notes?new=1&client=${client.id}`} size="sm" icon={<FilePlus2 className="h-4 w-4" />}>
                New note
              </LinkButton>
            )}
            {permissions.clinical && !emergencyAccess && (
              <ExportRecordButton clientId={client.id} includesBilling={permissions.billing} />
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
