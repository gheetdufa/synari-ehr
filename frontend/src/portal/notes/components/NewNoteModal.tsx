import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MAX_PAGE_SIZE } from '../../../api/client';
import { clientKeys, clientsApi, type ClientRef } from '../../../api/clients';
import {
  NOTE_TYPE_LABELS,
  PSYCHOTHERAPY_NOTE_HELP,
  noteKeys,
  notesApi,
  type NoteFormatId,
  type NoteType,
} from '../../../api/notes';
import { meApi, meKeys } from '../../../api/me';
import { useSession } from '../../../auth/StaffAuth';
import { Button } from '../../../ui/Button';
import { Checkbox, Field, Select } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';
import { ClientPicker } from '../../clients/ClientSearch';
import { appointmentLabel, useClientAppointments, useNoteFormats } from '../hooks';
import { startedDraftsMessage } from './SessionNotes';

const NO_APPOINTMENT = 'none';

/**
 * Form for starting a draft note; opens the editor once it's created. For a session with several
 * clients that you ran, it can instead start a draft for everyone and open the session's notes.
 */
function NewNoteForm({
  initialClientId,
  initialAppointmentId,
  onClose,
}: {
  initialClientId: number | null;
  initialAppointmentId: number | null;
  onClose: () => void;
}) {
  const { staff } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [pickedClient, setPickedClient] = useState<ClientRef | null | undefined>(undefined);
  const [appointmentChoice, setAppointmentChoice] = useState<string | null>(
    initialAppointmentId !== null ? String(initialAppointmentId) : null,
  );
  const [noteType, setNoteType] = useState<NoteType>('progress');
  const [formatChoice, setFormatChoice] = useState<NoteFormatId | null>(null);
  const [forEveryone, setForEveryone] = useState(false);

  const initialClient = useQuery({
    queryKey: clientKeys.detail(initialClientId ?? 0),
    queryFn: () => clientsApi.get(initialClientId!),
    enabled: initialClientId !== null && pickedClient === undefined,
  });
  const client = pickedClient === undefined ? (initialClient.data ?? null) : pickedClient;

  const formats = useNoteFormats();
  const preferences = useQuery({ queryKey: meKeys.preferences, queryFn: meApi.preferences });
  const format = formatChoice ?? preferences.data?.note_format_default ?? 'SOAP';

  const { appointments, isLoading: appointmentsLoading } = useClientAppointments(
    client?.id ?? null,
    pickedClient === undefined ? initialAppointmentId : null,
  );
  const myNotesParams = { client_id: client?.id, author_id: staff.id, limit: MAX_PAGE_SIZE };
  const clientNotes = useQuery({
    queryKey: noteKeys.list(myNotesParams),
    queryFn: () => notesApi.list(myNotesParams),
    select: (page) => page.items,
    enabled: client !== null,
  });
  const noted = new Set((clientNotes.data ?? []).map((note) => note.appointment_id));

  // Until the clinician picks, suggest their latest session with this client that has no note from them yet.
  const now = Date.now();
  const suggested = appointments.find(
    (appointment) => new Date(appointment.starts_at).getTime() <= now && !noted.has(appointment.id),
  );
  const appointmentValue =
    appointmentChoice ?? (suggested && clientNotes.isSuccess ? String(suggested.id) : NO_APPOINTMENT);
  const session = appointments.find((appointment) => String(appointment.id) === appointmentValue);
  // Only the session's own clinician can start notes for everyone in it.
  const groupSize = session && session.clinician.id === staff.id ? session.participants.length : 0;
  const writeForEveryone = forEveryone && groupSize > 1;

  const invalidateOverview = () => {
    void queryClient.invalidateQueries({ queryKey: noteKeys.lists });
    void queryClient.invalidateQueries({ queryKey: noteKeys.backlog });
  };

  const create = useMutation({
    mutationFn: () =>
      notesApi.create({
        client_id: client!.id,
        appointment_id: appointmentValue === NO_APPOINTMENT ? null : Number(appointmentValue),
        note_type: noteType,
        format,
      }),
    onSuccess: (note) => {
      queryClient.setQueryData(noteKeys.detail(note.id), note);
      invalidateOverview();
      navigate(`/portal/notes/${note.id}`);
    },
    onError: (error) => toast.error(error),
  });

  const createGroup = useMutation({
    mutationFn: (appointmentId: number) => notesApi.createGroup(appointmentId, { note_type: noteType, format }),
    onSuccess: (drafts, appointmentId) => {
      invalidateOverview();
      toast.success(startedDraftsMessage(drafts.length));
      navigate(`/portal/notes?session=${appointmentId}`);
    },
    onError: (error) => toast.error(error),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!client) return;
    if (writeForEveryone && session) createGroup.mutate(session.id);
    else create.mutate();
  };

  return (
    <form id="new-note-form" onSubmit={submit} className="space-y-4">
      <Field label="Client" required>
        {(props) =>
          initialClientId !== null && pickedClient === undefined && initialClient.isLoading ? (
            <div className="flex h-10 items-center rounded-lg border border-sage-200 px-3 text-sm text-sage-500">Loading…</div>
          ) : (
            <ClientPicker
              access="clinical"
              id={props.id}
              value={client}
              onChange={(next) => {
                setPickedClient(next);
                setAppointmentChoice(null);
              }}
            />
          )
        }
      </Field>

      <Field
        label="Appointment"
        hint={
          client
            ? appointments.length === 0 && !appointmentsLoading
              ? 'No appointments with this client in the last 30 days or the next 7.'
              : 'Linking the session marks it as documented.'
            : 'Choose a client first.'
        }
      >
        {(props) => (
          <Select
            {...props}
            value={appointmentValue}
            disabled={!client || appointmentsLoading}
            onChange={(event) => setAppointmentChoice(event.target.value)}
          >
            <option value={NO_APPOINTMENT}>{appointmentsLoading ? 'Loading appointments…' : 'No appointment'}</option>
            {appointments.map((appointment) => (
              <option key={appointment.id} value={appointment.id}>
                {appointmentLabel(appointment, staff.time_zone)}
                {noted.has(appointment.id) ? ' · has a note' : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {groupSize > 1 && (
        <Checkbox
          checked={forEveryone}
          onChange={(event) => setForEveryone(event.target.checked)}
          label={`Write a group note for everyone in this session (${groupSize} clients)`}
          description="Starts a draft for each client who doesn't have one from you yet, so every client has their own note. Clients marked absent are left out."
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Note type" hint={noteType === 'psychotherapy' ? PSYCHOTHERAPY_NOTE_HELP : undefined}>
          {(props) => (
            <Select {...props} value={noteType} onChange={(event) => setNoteType(event.target.value as NoteType)}>
              {(Object.keys(NOTE_TYPE_LABELS) as NoteType[]).map((type) => (
                <option key={type} value={type}>
                  {NOTE_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Format" hint={formats.data?.find((item) => item.id === format)?.description}>
          {(props) => (
            <Select
              {...props}
              value={format}
              disabled={!formats.data}
              onChange={(event) => setFormatChoice(event.target.value as NoteFormatId)}
            >
              {(formats.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="flex justify-end gap-2 border-t border-sage-100 pt-4">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={create.isPending || createGroup.isPending} disabled={!client || !formats.data}>
          {writeForEveryone ? 'Create notes' : 'Create note'}
        </Button>
      </div>
    </form>
  );
}

/** "New note" dialog: client, optional appointment, note type and format. */
export function NewNoteModal({
  open,
  onClose,
  initialClientId = null,
  initialAppointmentId = null,
}: {
  open: boolean;
  onClose: () => void;
  initialClientId?: number | null;
  initialAppointmentId?: number | null;
}) {
  return (
    <Modal open={open} onClose={onClose} title="New note" description="Start a draft. It saves automatically as you write.">
      {open && (
        <NewNoteForm initialClientId={initialClientId} initialAppointmentId={initialAppointmentId} onClose={onClose} />
      )}
    </Modal>
  );
}
