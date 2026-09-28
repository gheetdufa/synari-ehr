import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, UserPlus, Users } from 'lucide-react';
import { teamApi, teamKeys, type TeamMember } from '../../../api/team';
import { useCan, useSession } from '../../../auth/StaffAuth';
import { formatDate, initials } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card, CardHeader } from '../../../ui/Card';
import { Avatar, Badge, EmptyState, ErrorState, Popover, Td, Th } from '../../../ui/Display';
import { ConfirmDialog } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { ClinicianRatesModal } from './ClinicianRatesModal';
import { EditMemberModal } from './EditMemberModal';
import { InviteMemberModal } from './InviteMemberModal';
import { STATUS_LABELS, STATUS_TONES, roleSummary } from './teamRules';

type Dialog =
  | { kind: 'invite' }
  | { kind: 'edit' | 'rates' | 'revoke' | 'deactivate' | 'reactivate' | 'signOut' | 'resetMfa'; member: TeamMember }
  | null;

interface MemberAction {
  label: string;
  run: () => void;
  danger?: boolean;
}

function StatusBadge({ member, timeZone }: { member: TeamMember; timeZone: string }) {
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="inline-flex flex-wrap items-center gap-1">
        <Badge tone={STATUS_TONES[member.status]}>{STATUS_LABELS[member.status]}</Badge>
        {member.status === 'active' &&
          (member.mfa_enabled ? <Badge tone="success">2FA on</Badge> : <Badge tone="warning">No 2FA</Badge>)}
      </span>
      {member.status === 'invited' && member.invited_at && (
        <span className="text-xs text-sage-500">Sent {formatDate(member.invited_at, timeZone)}</span>
      )}
    </span>
  );
}

function ActionsMenu({ member, actions }: { member: TeamMember; actions: MemberAction[] }) {
  if (actions.length === 0) return null;
  return (
    <Popover
      className="w-56"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={`Actions for ${member.first_name} ${member.last_name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-sage-600 hover:bg-sage-100 hover:text-sage-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={`Actions for ${member.first_name} ${member.last_name}`} className="py-1">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                action.run();
              }}
              className={`flex w-full px-4 py-2 text-left text-sm focus:outline-none ${
                action.danger ? 'text-red-700 hover:bg-red-50 focus:bg-red-50' : 'text-sage-700 hover:bg-sage-50 focus:bg-sage-50'
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function Person({ member, isYou }: { member: TeamMember; isYou: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar label={initials(member)} className="h-8 w-8 text-xs" />
      <span className="min-w-0">
        <span className="block truncate font-medium text-sage-900">
          {member.display_name}
          {isYou && <span className="ml-1.5 text-xs font-normal text-sage-500">(you)</span>}
        </span>
        <span className="block truncate text-xs text-sage-500">{member.email}</span>
      </span>
    </span>
  );
}

/** The practice team: who's on it, their roles, invitations, deactivation and clinician rates. */
export function TeamSettings() {
  const { staff } = useSession();
  const canManageTeam = useCan('manage_team');
  const canManagePractice = useCan('manage_practice');
  const queryClient = useQueryClient();
  const toast = useToast();
  const team = useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list });
  const [dialog, setDialog] = useState<Dialog>(null);
  const members = team.data ?? [];
  const byId = new Map(members.map((member) => [member.id, member]));

  const refresh = () => queryClient.invalidateQueries({ queryKey: teamKeys.all });
  const finish = (message: string) => {
    void refresh();
    setDialog(null);
    toast.success(message);
  };
  const fail = (error: Error) => {
    setDialog(null);
    toast.error(error);
  };

  const resend = useMutation({
    mutationFn: (member: TeamMember) => teamApi.resendInvitation(member.id),
    onSuccess: (result) => toast.success(result.detail),
    onError: (error) => toast.error(error),
  });
  const revoke = useMutation({
    mutationFn: (member: TeamMember) => teamApi.revokeInvitation(member.id),
    onSuccess: (_result, member) => finish(`Invitation for ${member.email} withdrawn`),
    onError: fail,
  });
  const deactivate = useMutation({
    mutationFn: (member: TeamMember) => teamApi.deactivate(member.id),
    onSuccess: (member) => finish(`${member.first_name} ${member.last_name} was deactivated`),
    onError: fail,
  });
  const reactivate = useMutation({
    mutationFn: (member: TeamMember) => teamApi.reactivate(member.id),
    onSuccess: (member) => finish(`${member.first_name} ${member.last_name} can sign in again`),
    onError: fail,
  });
  const signOut = useMutation({
    mutationFn: (member: TeamMember) => teamApi.signOutEverywhere(member.id),
    onSuccess: (_result, member) => finish(`${member.first_name} ${member.last_name} was signed out of all devices`),
    onError: fail,
  });
  const resetMfa = useMutation({
    mutationFn: (member: TeamMember) => teamApi.resetMfa(member.id),
    onSuccess: (member) => finish(`Two-factor authentication reset for ${member.first_name} ${member.last_name}`),
    onError: fail,
  });

  /** What the signed-in person can do to a member. Only owners can manage owners. */
  const actionsFor = (member: TeamMember): MemberAction[] => {
    const manageable = canManageTeam && (member.role !== 'owner' || staff.role === 'owner');
    const isYou = member.id === staff.id;
    const actions: MemberAction[] = [];
    if (manageable) actions.push({ label: 'Edit', run: () => setDialog({ kind: 'edit', member }) });
    if (canManagePractice && member.is_clinician && member.status !== 'deactivated') {
      actions.push({ label: 'Services & rates', run: () => setDialog({ kind: 'rates', member }) });
    }
    if (!manageable) return actions;
    if (member.status === 'invited') {
      actions.push({ label: 'Resend invitation', run: () => resend.mutate(member) });
      actions.push({ label: 'Withdraw invitation', danger: true, run: () => setDialog({ kind: 'revoke', member }) });
    }
    if (member.status === 'active' && !isYou) {
      actions.push({ label: 'Sign out of all devices', run: () => setDialog({ kind: 'signOut', member }) });
      if (staff.role === 'owner' && member.mfa_enabled) {
        actions.push({ label: 'Reset 2FA', danger: true, run: () => setDialog({ kind: 'resetMfa', member }) });
      }
      actions.push({ label: 'Deactivate', danger: true, run: () => setDialog({ kind: 'deactivate', member }) });
    }
    if (member.status === 'deactivated') {
      actions.push({ label: 'Reactivate', run: () => setDialog({ kind: 'reactivate', member }) });
    }
    return actions;
  };

  const supervisorLine = (member: TeamMember): ReactNode => {
    const supervisor = member.supervisor_id === null ? undefined : byId.get(member.supervisor_id);
    return supervisor ? <span className="block text-xs text-sage-500">Supervised by {supervisor.display_name}</span> : null;
  };

  const target = dialog && dialog.kind !== 'invite' ? dialog.member : null;
  const name = target ? `${target.first_name} ${target.last_name}` : '';

  return (
    <Card>
      <CardHeader
        title="Team"
        description={
          canManageTeam
            ? 'Invite clinicians and staff, and choose what each person can see and do.'
            : 'Everyone in the practice. Owners and practice managers manage the team.'
        }
        actions={
          canManageTeam && (
            <Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setDialog({ kind: 'invite' })}>
              Invite
            </Button>
          )
        }
      />
      {team.isPending && <SectionSpinner />}
      {team.isError && <ErrorState error={team.error} onRetry={() => void refresh()} />}
      {team.data && members.length === 0 && <EmptyState icon={<Users />} title="No team members yet" />}
      {members.length > 0 && (
        <>
          <div className="hidden md:block">
            {/* Not the ui Table: its scroll container would clip the row action menus. */}
            <table className="min-w-full divide-y divide-sage-100 text-sm">
              <thead className="bg-sage-50/60">
                <tr>
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sage-100">
                {members.map((member) => (
                  <tr key={member.id} className={member.status === 'deactivated' ? 'opacity-70' : undefined}>
                    <Td>
                      <Person member={member} isYou={member.id === staff.id} />
                    </Td>
                    <Td>
                      <span className="block">{roleSummary(member)}</span>
                      {supervisorLine(member)}
                    </Td>
                    <Td>
                      <StatusBadge member={member} timeZone={staff.time_zone} />
                    </Td>
                    <Td className="text-right">
                      <ActionsMenu member={member} actions={actionsFor(member)} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-sage-100 md:hidden">
            {members.map((member) => (
              <li key={member.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Person member={member} isYou={member.id === staff.id} />
                  <p className="text-sage-700">
                    {roleSummary(member)}
                    {supervisorLine(member)}
                  </p>
                  <StatusBadge member={member} timeZone={staff.time_zone} />
                </div>
                <ActionsMenu member={member} actions={actionsFor(member)} />
              </li>
            ))}
          </ul>
        </>
      )}

      {dialog?.kind === 'invite' && <InviteMemberModal team={members} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <EditMemberModal member={dialog.member} team={members} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rates' && <ClinicianRatesModal member={dialog.member} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog?.kind === 'revoke'}
        title="Withdraw this invitation?"
        message={`The link sent to ${target?.email ?? ''} will stop working. You can invite them again later.`}
        confirmLabel="Withdraw invitation"
        danger
        loading={revoke.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => target && revoke.mutate(target)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'deactivate'}
        title={`Deactivate ${name}?`}
        message={
          <>
            <p>They&apos;ll be signed out everywhere and won&apos;t be able to sign in.</p>
            <p className="mt-2">
              Their notes, appointments and history stay in the practice. Reassign their clients to another clinician
              so nobody is left without care.
            </p>
          </>
        }
        confirmLabel="Deactivate"
        danger
        loading={deactivate.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => target && deactivate.mutate(target)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'signOut'}
        title={`Sign ${name} out of all devices?`}
        message="They'll be signed out everywhere right away and need to sign in again. Use this when a device was lost or shared."
        confirmLabel="Sign out of all devices"
        danger
        loading={signOut.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => target && signOut.mutate(target)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'resetMfa'}
        title={`Reset two-factor authentication for ${name}?`}
        message={
          <>
            <p>
              Their authenticator app and recovery codes stop working, they&apos;re signed out everywhere, and we email
              them. They set up two-factor again after they next sign in with their password.
            </p>
            <p className="mt-2">Only do this once you&apos;re sure who is asking, for example by phone or in person.</p>
          </>
        }
        confirmLabel="Reset 2FA"
        danger
        loading={resetMfa.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => target && resetMfa.mutate(target)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'reactivate'}
        title={`Reactivate ${name}?`}
        message="They'll be able to sign in again with their existing password and role."
        confirmLabel="Reactivate"
        loading={reactivate.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => target && reactivate.mutate(target)}
      />
    </Card>
  );
}
