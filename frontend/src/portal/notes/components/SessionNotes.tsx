import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, FilePlus2, Lock, Users } from 'lucide-react';
import {
  appointmentKeys,
  appointmentsApi,
  STATUS_LABELS,
  type Appointment,
  type AppointmentStatus,
} from '../../../api/appointments';
import { ApiError, MAX_PAGE_SIZE } from '../../../api/client';
import { noteKeys, notesApi, type NoteFormat, type NoteSummary } from '../../../api/notes';
import { useSession } from '../../../auth/StaffAuth';
import { formatDateTime } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card, CardHeader } from '../../../ui/Card';
import { Badge, EmptyState, ErrorState } from '../../../ui/Display';
import { ConfirmDialog } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { NoteList } from './NoteList';

/** Clients with one of these statuses weren't in the session, so get no session note. */
const ABSENT: ReadonlySet<AppointmentStatus> = new Set(['no_show', 'canceled', 'late_canceled', 'declined']);

type Participant = Appointment['participants'][number];

/** What starting a group note did: how many drafts it created. */
export function startedDraftsMessage(count: number): string {
  if (count === 0) return 'Everyone in this session already has a note from you.';
  return `Started ${count} draft${count === 1 ? '' : 's'}, one for each client.`;
}

function ParticipantNotes({
  participant,
  notes,
  canWrite,
  writing,
  onWrite,
  formats,
  timeZone,
}: {
  participant: Participant;
  notes: NoteSummary[];
  canWrite: boolean;
  writing: boolean;
  onWrite: () => void;
  formats: NoteFormat[] | undefined;
  timeZone: string;
}) {
  const absent = ABSENT.has(participant.effective_status);
  return (
    <section aria-label={participant.client.name} className="border-b border-sage-100 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-5">
        <h3 className="flex-1 font-medium text-sage-900">{participant.client.name}</h3>
        {absent && <Badge>{STATUS_LABELS[participant.effective_status]}</Badge>}
        {canWrite && !absent && (
          <Button size="sm" variant="secondary" loading={writing} onClick={onWrite} aria-label={`Write a note for ${participant.client.name}`}>
            Write note
          </Button>
        )}
      </div>
      {notes.length > 0 ? (
        <NoteList notes={notes} formats={formats} timeZone={timeZone} showClient={false} label={`Notes for ${participant.client.name}`} />
      ) : (
        <p className="px-4 pb-3 pt-1 text-sm text-sage-500 sm:px-5">{absent ? 'Not in the session.' : 'No note yet.'}</p>
      )}
    </section>
  );
}

/**
 * /portal/notes?session=ID — every note from one appointment, grouped by client. The session's
 * clinician can start a draft for everyone at once ("group note") and sign all of their drafts.
 */
export function SessionNotes({
  appointmentId,
  formats,
  onBack,
}: {
  appointmentId: number;
  formats: NoteFormat[] | undefined;
  onBack: () => void;
}) {
  const { staff } = useSession();
  const timeZone = staff.time_zone;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmSignAll, setConfirmSignAll] = useState(false);

  const appointment = useQuery({
    queryKey: appointmentKeys.detail(appointmentId),
    queryFn: () => appointmentsApi.get(appointmentId),
  });
  const listParams = { appointment_id: appointmentId, limit: MAX_PAGE_SIZE };
  const notes = useQuery({
    queryKey: noteKeys.list(listParams),
    queryFn: () => notesApi.list(listParams),
    select: (page) => page.items,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: noteKeys.lists });
    void queryClient.invalidateQueries({ queryKey: noteKeys.backlog });
  };

  const writeOne = useMutation({
    mutationFn: (clientId: number) => notesApi.create({ client_id: clientId, appointment_id: appointmentId }),
    onSuccess: (note) => {
      queryClient.setQueryData(noteKeys.detail(note.id), note);
      refresh();
      navigate(`/portal/notes/${note.id}`);
    },
    onError: (error) => toast.error(error),
  });

  const writeGroup = useMutation({
    mutationFn: () => notesApi.createGroup(appointmentId, {}),
    onSuccess: (drafts) => {
      refresh();
      toast.success(startedDraftsMessage(drafts.length));
    },
    onError: (error) => toast.error(error),
  });

  const signAll = useMutation({
    mutationFn: () => notesApi.signSession(appointmentId),
    onSuccess: (signed) => {
      setConfirmSignAll(false);
      signed.forEach((note) => queryClient.setQueryData(noteKeys.detail(note.id), note));
      refresh();
      const pending = signed.find((note) => note.status === 'pending_cosign');
      const count = `${signed.length} note${signed.length === 1 ? '' : 's'}`;
      toast.success(
        pending ? `Signed ${count} and sent them to ${pending.supervisor?.name ?? 'your supervisor'} to co-sign.` : `Signed ${count}.`,
      );
    },
    onError: (error) => {
      setConfirmSignAll(false);
      toast.error(error);
    },
  });

  if (appointment.isLoading || notes.isLoading) return <SectionSpinner />;
  if (appointment.error instanceof ApiError && appointment.error.status === 404) {
    return (
      <Card>
        <EmptyState
          icon={<Users />}
          title="Session not found"
          description="It may have been deleted, or it isn't on a calendar you can see."
          action={<Button variant="secondary" onClick={onBack}>Back to notes</Button>}
        />
      </Card>
    );
  }
  const error = appointment.error ?? notes.error;
  if (error || !appointment.data) {
    return (
      <Card>
        <ErrorState
          error={error}
          onRetry={() => {
            void appointment.refetch();
            void notes.refetch();
          }}
        />
      </Card>
    );
  }

  const session = appointment.data;
  const sessionNotes = notes.data ?? [];
  const mine = sessionNotes.filter((note) => note.author.id === staff.id);
  const myDrafts = mine.filter((note) => note.status === 'draft');
  const isHost = staff.is_clinician && session.clinician.id === staff.id;
  const hasMyNote = (clientId: number) => mine.some((note) => note.client.id === clientId);
  const needNotes = session.participants.filter(
    (participant) => !ABSENT.has(participant.effective_status) && !hasMyNote(participant.client.id),
  );
  const participantIds = new Set(session.participants.map((participant) => participant.client.id));
  const otherNotes = sessionNotes.filter((note) => !participantIds.has(note.client.id));
  const service = session.service_description || session.service_code;

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-sage-700 hover:bg-sage-100 hover:text-sage-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All notes
      </button>
      <Card>
        <CardHeader
          title={`Session notes · ${session.title_label}`}
          description={[formatDateTime(session.starts_at, timeZone), service, session.clinician.name].filter(Boolean).join(' · ')}
          actions={
            <>
              {isHost && needNotes.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FilePlus2 className="h-4 w-4" />}
                  loading={writeGroup.isPending}
                  onClick={() => writeGroup.mutate()}
                >
                  {mine.length === 0 ? 'Write a group note' : `Start the other ${needNotes.length} note${needNotes.length === 1 ? '' : 's'}`}
                </Button>
              )}
              {myDrafts.length > 0 && (
                <Button size="sm" icon={<Lock className="h-4 w-4" />} onClick={() => setConfirmSignAll(true)}>
                  Sign all ({myDrafts.length})
                </Button>
              )}
            </>
          }
        />
        {session.restricted ? (
          <p className="px-4 py-4 text-sm text-sage-600 sm:px-5">You can't see the clients in this session.</p>
        ) : (
          <>
            {isHost && needNotes.length > 0 && (
              <p className="border-b border-sage-100 px-4 py-2 text-xs text-sage-500 sm:px-5">
                A group note starts a draft for each client who doesn&apos;t have one from you yet, so every client has their own note in their record.
              </p>
            )}
            {session.participants.map((participant) => (
              <ParticipantNotes
                key={participant.id}
                participant={participant}
                notes={sessionNotes.filter((note) => note.client.id === participant.client.id)}
                canWrite={isHost && !hasMyNote(participant.client.id)}
                writing={writeOne.isPending && writeOne.variables === participant.client.id}
                onWrite={() => writeOne.mutate(participant.client.id)}
                formats={formats}
                timeZone={timeZone}
              />
            ))}
            {otherNotes.length > 0 && (
              <section aria-label="Other notes from this session">
                <h3 className="px-4 pt-3 font-medium text-sage-900 sm:px-5">Clients no longer in this session</h3>
                <NoteList notes={otherNotes} formats={formats} timeZone={timeZone} label="Other notes from this session" />
              </section>
            )}
          </>
        )}
      </Card>

      <ConfirmDialog
        open={confirmSignAll}
        title={`Sign ${myDrafts.length} note${myDrafts.length === 1 ? '' : 's'}?`}
        confirmLabel="Sign all"
        loading={signAll.isPending}
        onConfirm={() => signAll.mutate()}
        onCancel={() => setConfirmSignAll(false)}
        message={
          <div className="space-y-2">
            <p>
              Each of your drafts from this session is signed and locked. Nothing is signed if any of them is still empty.
            </p>
            <p className="text-sage-600">
              If you have a supervisor, the notes then wait for their co-signature. Session audio is deleted once every note
              is signed.
            </p>
          </div>
        }
      />
    </div>
  );
}
