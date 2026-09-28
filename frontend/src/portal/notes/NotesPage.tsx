import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Plus } from 'lucide-react';
import { clientKeys, clientsApi } from '../../api/clients';
import {
  NOTE_STATUS_LABELS,
  NOTE_TYPE_LABELS,
  noteKeys,
  notesApi,
  type NoteListParams,
  type NoteStatus,
  type NoteType,
} from '../../api/notes';
import { useCan, useSession } from '../../auth/StaffAuth';
import { usePagedQuery } from '../../lib/paging';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState, ErrorState, PageHeader, Tabs, type TabItem } from '../../ui/Display';
import { Select } from '../../ui/Form';
import { LoadMore } from '../../ui/LoadMore';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { ClientPicker } from '../clients/ClientSearch';
import { CosignQueue } from './components/CosignQueue';
import { NeedsAttention } from './components/NeedsAttention';
import { NewNoteModal } from './components/NewNoteModal';
import { NoteList } from './components/NoteList';
import { SessionNotes } from './components/SessionNotes';
import { useNoteFormats, useNotesRealtime, useSupervision, useTeam } from './hooks';

/** A status filter, or the supervisor's co-sign queue. */
type ListTab = NoteStatus | 'all' | 'cosign';
type TypeFilter = NoteType | 'all';

const STATUS_TABS: TabItem<ListTab>[] = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Drafts' },
  { id: 'pending_cosign', label: NOTE_STATUS_LABELS.pending_cosign },
  { id: 'signed', label: 'Signed' },
];

function parseId(value: string | null): number | null {
  const id = Number(value);
  return value && Number.isInteger(id) && id > 0 ? id : null;
}

function parseStatus(value: string | null): NoteStatus | 'all' {
  return value && value in NOTE_STATUS_LABELS ? (value as NoteStatus) : 'all';
}

function parseType(value: string | null): TypeFilter {
  return value && value in NOTE_TYPE_LABELS ? (value as NoteType) : 'all';
}

/**
 * /portal/notes — every note you can read, filterable by status, client, type and author, with
 * what needs your attention on top. `?view=cosign` is a supervisor's co-sign queue and
 * `?session=ID` shows one appointment's notes (group notes, Sign all). `?new=1&client=ID&appointment=ID`
 * opens the new-note dialog prefilled; with both ids it opens your note for that session
 * directly (creating it if needed).
 */
export default function NotesPage() {
  const { staff } = useSession();
  const clinicalAll = useCan('clinical_all');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  useNotesRealtime();

  const status = parseStatus(params.get('status'));
  const showQueue = params.get('view') === 'cosign';
  const sessionId = parseId(params.get('session'));
  const clientId = parseId(params.get('client'));
  const authorId = parseId(params.get('author'));
  const noteType = parseType(params.get('type'));
  const wantsNew = params.get('new') === '1';
  const appointmentId = parseId(params.get('appointment'));

  const updateParams = (changes: Record<string, string | null>, replace = true) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace },
    );

  const formats = useNoteFormats();
  const team = useTeam();
  const { supervisees } = useSupervision();
  const backlog = useQuery({ queryKey: noteKeys.backlog, queryFn: notesApi.backlog });
  const queueCount = backlog.data?.notes_awaiting_cosign ?? 0;
  const supervises = supervisees.length > 0 || queueCount > 0;
  const tabs: TabItem<ListTab>[] = supervises
    ? [...STATUS_TABS, { id: 'cosign', label: 'Co-sign queue', count: queueCount }]
    : STATUS_TABS;

  // Authors to filter by: everyone who writes notes with practice-wide clinical access, else my supervisees.
  const authors = clinicalAll
    ? (team.data ?? []).filter((member) => member.is_clinician && member.status === 'active' && member.id !== staff.id)
    : supervisees;
  const filterByAuthor = clinicalAll || supervisees.length > 0;

  const listParams: NoteListParams = {
    status: status === 'all' ? undefined : status,
    client_id: clientId ?? undefined,
    author_id: authorId ?? undefined,
    note_type: noteType === 'all' ? undefined : noteType,
  };
  const listing = !showQueue && sessionId === null;
  const notes = usePagedQuery({
    queryKey: noteKeys.pages(listParams),
    fetchPage: (page) => notesApi.list({ ...listParams, ...page }),
    enabled: listing,
  });
  const filterClient = useQuery({
    queryKey: clientKeys.detail(clientId ?? 0),
    queryFn: () => clientsApi.get(clientId!),
    enabled: clientId !== null,
  });

  const openSessionNote = useMutation({
    mutationFn: async ({ client, appointment }: { client: number; appointment: number }) => {
      const existing = await notesApi.list({ appointment_id: appointment, client_id: client, author_id: staff.id, limit: 1 });
      if (existing.items.length > 0) return { id: existing.items[0].id, existed: true };
      const note = await notesApi.create({ client_id: client, appointment_id: appointment });
      queryClient.setQueryData(noteKeys.detail(note.id), note);
      return { id: note.id, existed: false };
    },
    onSuccess: ({ id, existed }) => {
      void queryClient.invalidateQueries({ queryKey: noteKeys.lists });
      void queryClient.invalidateQueries({ queryKey: noteKeys.backlog });
      if (existed) toast.success('You already have a note for this client and session, so we opened it.');
      navigate(`/portal/notes/${id}`, { replace: true });
    },
    onError: (error) => toast.error(error),
  });

  const autoOpen = wantsNew && clientId !== null && appointmentId !== null;
  const handledRef = useRef<string | null>(null);
  const { mutate: openNoteFor } = openSessionNote;
  useEffect(() => {
    if (!autoOpen) return;
    const key = `${clientId}:${appointmentId}`;
    if (handledRef.current === key) return;
    handledRef.current = key;
    openNoteFor({ client: clientId!, appointment: appointmentId! });
  }, [autoOpen, clientId, appointmentId, openNoteFor]);

  if (autoOpen && !openSessionNote.isError) return <SectionSpinner />;

  const openNew = () => updateParams({ new: '1' }, false);
  const newNoteButton = staff.is_clinician && (
    <Button icon={<Plus className="h-4 w-4" />} onClick={openNew}>
      New note
    </Button>
  );
  const visible = notes.items;
  const filtered = status !== 'all' || clientId !== null || noteType !== 'all' || authorId !== null;
  const clientRef = filterClient.data ?? null;

  const list = notes.isLoading ? (
    <SectionSpinner />
  ) : notes.isError && !notes.data ? (
    <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
  ) : visible.length === 0 ? (
    filtered ? (
      <EmptyState
        icon={<FileText />}
        title="No notes match these filters"
        action={
          <Button variant="secondary" onClick={() => updateParams({ status: null, client: null, type: null, author: null })}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<FileText />}
        title="No notes yet"
        description={staff.is_clinician ? 'Write your first note from a session, or start one here.' : 'Notes you can read appear here.'}
        action={newNoteButton || undefined}
      />
    )
  ) : (
    <>
      <NoteList notes={visible} formats={formats.data} timeZone={staff.time_zone} label="Notes" showClient={clientId === null} />
      <LoadMore noun="notes" {...notes.loadMore} />
    </>
  );

  return (
    <div>
      <PageHeader title="Notes" description="Session notes and clinical documentation." actions={newNoteButton} />

      {sessionId !== null ? (
        <SessionNotes appointmentId={sessionId} formats={formats.data} onBack={() => updateParams({ session: null }, false)} />
      ) : (
        <>
          {clientId === null && !showQueue && (
            <NeedsAttention
              formats={formats.data}
              timeZone={staff.time_zone}
              showDrafts={status !== 'draft'}
              showCosign={supervises}
              onShowAllDrafts={() => updateParams({ status: 'draft', author: String(staff.id) })}
              onOpenCosignQueue={() => updateParams({ view: 'cosign', status: null })}
              onWrite={(client, appointment) =>
                updateParams({ new: '1', client: String(client), appointment: String(appointment) }, false)
              }
              onOpenSession={(appointment) => updateParams({ session: String(appointment) }, false)}
            />
          )}

          <Card>
            <div className="px-4 pt-2 sm:px-5">
              <Tabs
                tabs={tabs}
                active={showQueue ? 'cosign' : status}
                onChange={(next) =>
                  next === 'cosign'
                    ? updateParams({ view: 'cosign', status: null })
                    : updateParams({ view: null, status: next === 'all' ? null : next })
                }
              />
            </div>
            {showQueue ? (
              <CosignQueue formats={formats.data} timeZone={staff.time_zone} />
            ) : (
              <>
                <div className="flex flex-col gap-3 border-b border-sage-100 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-5">
                  <div className="sm:w-72">
                    {clientId !== null && filterClient.isLoading ? (
                      <div className="flex h-10 items-center rounded-lg border border-sage-200 px-3 text-sm text-sage-500">Loading…</div>
                    ) : (
                      <ClientPicker
                        access="clinical"
                        value={clientRef}
                        onChange={(client) => updateParams({ client: client ? String(client.id) : null })}
                        placeholder="Filter by client…"
                        clearLabel="Show all clients"
                      />
                    )}
                  </div>
                  <div className="sm:w-56">
                    <Select
                      aria-label="Note type"
                      value={noteType}
                      onChange={(event) => updateParams({ type: event.target.value === 'all' ? null : event.target.value })}
                    >
                      <option value="all">All note types</option>
                      {(Object.keys(NOTE_TYPE_LABELS) as NoteType[]).map((type) => (
                        <option key={type} value={type}>
                          {NOTE_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {(filterByAuthor || authorId !== null) && (
                    <div className="sm:w-56">
                      <Select
                        aria-label="Author"
                        value={authorId === null ? '' : String(authorId)}
                        onChange={(event) => updateParams({ author: event.target.value || null })}
                      >
                        <option value="">All authors</option>
                        {staff.is_clinician && <option value={staff.id}>Me</option>}
                        {authors.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.display_name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                </div>
                {list}
              </>
            )}
          </Card>
        </>
      )}

      <NewNoteModal
        open={wantsNew && (!autoOpen || openSessionNote.isError)}
        onClose={() => updateParams({ new: null, appointment: null })}
        initialClientId={clientId}
        initialAppointmentId={appointmentId}
      />
    </div>
  );
}
