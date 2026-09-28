import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Send } from 'lucide-react';
import type { Appointment } from '../api/appointments';
import { telehealthApi, telehealthKeys, type SendLinkResult } from '../api/telehealth';
import { fullName } from '../lib/format';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/Display';
import { Modal } from '../ui/Modal';
import { SectionSpinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';

/** A client in a session, by id and display name. */
export interface SessionClient {
  id: number;
  name: string;
}

type LinkAppointment = Pick<Appointment, 'id' | 'participants'>;

/** Links are signed tokens that stay valid for the whole appointment, so a short cache is safe. */
const LINKS_STALE_MS = 5 * 60_000;
const UNREACHABLE = 'no email address or text-message consent';

function listNames(names: string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function howSent(result: SendLinkResult): string {
  if (result.email_sent && result.sms_sent) return 'emailed and texted';
  return result.email_sent ? 'emailed' : 'texted';
}

/** What the toast says after sending join links: who got theirs, and who couldn't be reached. */
export function describeSentLinks(results: SendLinkResult[], nameOf: (clientId: number) => string): string {
  const reached = results.filter((result) => result.email_sent || result.sms_sent);
  const missed = results.filter((result) => !result.email_sent && !result.sms_sent).map((result) => nameOf(result.client_id));
  let message: string;
  if (reached.length === 0) message = '';
  else if (reached.length === 1) message = `Join link ${howSent(reached[0])} to ${nameOf(reached[0].client_id)}.`;
  else message = `Join links sent to ${reached.length} clients.`;
  if (missed.length === 0) return message;
  const unreached = `${listNames(missed)} ${missed.length === 1 ? 'has' : 'have'} ${UNREACHABLE}.`;
  return message ? `${message} ${unreached}` : unreached;
}

/** The session's clients as the join-link buttons name them. */
function sessionClients(appointment: LinkAppointment): SessionClient[] {
  return appointment.participants.map((participant) => ({ id: participant.client.id, name: participant.client.name }));
}

interface ManualLink {
  name: string;
  url: string;
}

/** Copy and send one appointment's join links, naming the clients in the toasts. */
function useJoinLinkSharing(appointmentId: number, clients: SessionClient[]) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [manual, setManual] = useState<ManualLink | null>(null);
  const nameOf = (clientId: number) => clients.find((client) => client.id === clientId)?.name ?? 'your client';

  const copy = useMutation({
    mutationFn: async (client: SessionClient) => {
      const links = await queryClient.fetchQuery({
        queryKey: telehealthKeys.joinLinks(appointmentId),
        queryFn: () => telehealthApi.joinLinks(appointmentId),
        staleTime: LINKS_STALE_MS,
      });
      const link = links.find((item) => item.client.id === client.id);
      if (!link) throw new Error(`${client.name} is no longer in this appointment.`);
      return { name: client.name, url: link.url };
    },
    onSuccess: async (link) => {
      try {
        await navigator.clipboard.writeText(link.url);
        toast.success(`${link.name}'s join link copied. It works from 60 minutes before the appointment.`);
      } catch {
        setManual(link);
      }
    },
    onError: (error) => toast.error(error),
  });

  const send = useMutation({
    mutationFn: (clientId: number | undefined) => telehealthApi.sendLinks(appointmentId, clientId),
    onSuccess: (results) => toast.success(describeSentLinks(results, nameOf)),
    onError: (error) => toast.error(error),
  });

  return { copy, send, manual, clearManual: () => setManual(null) };
}

function ManualLinkField({ link }: { link: ManualLink }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-sage-800">
        {link.name}&apos;s join link
      </label>
      <input
        id={id}
        readOnly
        value={link.url}
        onFocus={(event) => event.currentTarget.select()}
        className="block h-10 w-full rounded-lg border border-sage-200 bg-sage-50 px-3 text-sm text-sage-900"
      />
    </div>
  );
}

function ManualLinkDialog({ link, onClose }: { link: ManualLink | null; onClose: () => void }) {
  return (
    <Modal
      open={link !== null}
      onClose={onClose}
      title="Copy the join link"
      description="Your browser didn't allow copying automatically. Select the link and copy it."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {link && <ManualLinkField link={link} />}
    </Modal>
  );
}

const DARK =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-medium text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:opacity-50';

type Tone = 'light' | 'dark';

/** A small action button; `hidden` adds words for screen readers (e.g. which client it's for). */
function ActionButton({
  tone,
  icon,
  label,
  hidden,
  loading,
  onClick,
}: {
  tone: Tone;
  icon: 'copy' | 'send' | 'links';
  label: string;
  hidden?: string;
  loading?: boolean;
  onClick: () => void;
}) {
  const Icon = icon === 'copy' ? Copy : icon === 'send' ? Send : Link2;
  const text = (
    <>
      {label}
      {hidden && <span className="sr-only"> {hidden}</span>}
    </>
  );
  if (tone === 'dark') {
    return (
      <button type="button" className={DARK} disabled={loading} onClick={onClick}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {text}
      </button>
    );
  }
  return (
    <Button variant="secondary" size="sm" loading={loading} icon={<Icon className="h-4 w-4" aria-hidden="true" />} onClick={onClick}>
      {text}
    </Button>
  );
}

/** Copy and Send buttons for one client's join link. */
export function ClientLinkButtons({ appointmentId, client, tone = 'light' }: { appointmentId: number; client: SessionClient; tone?: Tone }) {
  const { copy, send, manual, clearManual } = useJoinLinkSharing(appointmentId, [client]);
  return (
    <>
      <ActionButton
        tone={tone}
        icon="copy"
        label={tone === 'dark' ? 'Copy join link' : 'Copy link'}
        hidden={`for ${client.name}`}
        loading={copy.isPending}
        onClick={() => copy.mutate(client)}
      />
      <ActionButton
        tone={tone}
        icon="send"
        label="Send link"
        hidden={`to ${client.name}`}
        loading={send.isPending}
        onClick={() => send.mutate(client.id)}
      />
      <ManualLinkDialog link={manual} onClose={clearManual} />
    </>
  );
}

/** Every client's join link, each with Copy and Send, plus Send to everyone. */
function JoinLinksDialog({
  open,
  appointmentId,
  clients,
  onClose,
}: {
  open: boolean;
  appointmentId: number;
  clients: SessionClient[];
  onClose: () => void;
}) {
  const { copy, send, manual } = useJoinLinkSharing(appointmentId, clients);
  const links = useQuery({
    queryKey: telehealthKeys.joinLinks(appointmentId),
    queryFn: () => telehealthApi.joinLinks(appointmentId),
    staleTime: LINKS_STALE_MS,
    enabled: open,
  });
  const busy = (clientId: number | undefined) => send.isPending && send.variables === clientId;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Join links"
      description="Each client has their own link. Links work from 60 minutes before the appointment."
      footer={
        <>
          <Button variant="secondary" icon={<Send className="h-4 w-4" />} loading={busy(undefined)} onClick={() => send.mutate(undefined)}>
            Send to everyone
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      {links.isLoading ? (
        <SectionSpinner />
      ) : links.error ? (
        <ErrorState error={links.error} onRetry={() => void links.refetch()} />
      ) : (
        <div className="space-y-4">
          <ul className="divide-y divide-sage-100" aria-label="Clients' join links">
            {(links.data ?? []).map((link) => {
              const name = fullName(link.client);
              const client = { id: link.client.id, name };
              return (
                <li key={link.client.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-sage-900">{name}</span>
                  <ActionButton
                    tone="light"
                    icon="copy"
                    label="Copy"
                    hidden={`${name}'s link`}
                    loading={copy.isPending && copy.variables?.id === link.client.id}
                    onClick={() => copy.mutate(client)}
                  />
                  <ActionButton
                    tone="light"
                    icon="send"
                    label="Send"
                    hidden={`${name}'s link`}
                    loading={busy(link.client.id)}
                    onClick={() => send.mutate(link.client.id)}
                  />
                </li>
              );
            })}
          </ul>
          {manual && (
            <div className="rounded-lg bg-sage-50 p-3">
              <p className="mb-2 text-sm text-sage-700">Your browser didn&apos;t allow copying automatically. Select the link and copy it.</p>
              <ManualLinkField link={manual} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * Join-link sharing for a video appointment. A one-client session gets Copy link and Send link;
 * a couples, family or group session opens a list with each client's own link. If the clipboard
 * is blocked, the link is shown to copy by hand.
 */
export function JoinLinkActions({ appointment, tone = 'light' }: { appointment: LinkAppointment; tone?: Tone }) {
  const clients = sessionClients(appointment);
  if (clients.length === 0) return null;
  if (clients.length === 1) return <ClientLinkButtons appointmentId={appointment.id} client={clients[0]} tone={tone} />;
  return <SessionLinks appointmentId={appointment.id} clients={clients} tone={tone} />;
}

function SessionLinks({ appointmentId, clients, tone }: { appointmentId: number; clients: SessionClient[]; tone: Tone }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton tone={tone} icon="links" label={`Join links (${clients.length})`} onClick={() => setOpen(true)} />
      <JoinLinksDialog open={open} appointmentId={appointmentId} clients={clients} onClose={() => setOpen(false)} />
    </>
  );
}
