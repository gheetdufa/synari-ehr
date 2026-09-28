import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, MessageSquareReply, XCircle } from 'lucide-react';
import { noteKeys, notesApi } from '../../api/notes';
import {
  MAX_ADDENDUM_CHARS,
  MAX_DENIAL_CHARS,
  MAX_REQUEST_CHARS,
  REQUESTED_BY_LABELS,
  recordKeys,
  recordsApi,
  type AmendmentRequest,
} from '../../api/records';
import { useSession } from '../../auth/StaffAuth';
import { formatDate, formatDateTime, formatPlainDate, fullName } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Display';
import { Field, Select, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { ReasonDialog } from '../../ui/ReasonDialog';
import { useToast } from '../../ui/Toast';
import {
  AMENDMENT_STATUS_LABELS,
  HIGHLIGHT_CLASSES,
  STATUS_TONES,
  dueText,
  dueTone,
  useHighlight,
} from './recordHelpers';

/**
 * Accepting an amendment adds an addendum to one of the client's signed notes (never a
 * psychotherapy note): the one the request named, or one chosen here.
 */
export function AcceptAmendmentDialog({ amendment, onClose }: { amendment: AmendmentRequest; onClose: () => void }) {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [noteId, setNoteId] = useState<number | null>(amendment.note_id);
  const [content, setContent] = useState('');
  const [errors, setErrors] = useState<{ note?: string; content?: string }>({});
  const noteParams = { client_id: amendment.client.id, limit: 200 };
  const notes = useQuery({
    queryKey: noteKeys.list(noteParams),
    queryFn: () => notesApi.list(noteParams),
    enabled: amendment.note_id === null,
  });
  const choices = (notes.data?.items ?? []).filter((note) => note.status !== 'draft' && note.note_type !== 'psychotherapy');
  const accept = useMutation({
    mutationFn: () =>
      recordsApi.acceptAmendment(amendment.id, {
        content: content.trim(),
        ...(amendment.note_id === null && noteId !== null ? { note_id: noteId } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: recordKeys.all });
      void queryClient.invalidateQueries({ queryKey: noteKeys.all });
      toast.success('Amendment accepted. The client was notified.');
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (noteId === null) found.note = 'Choose the note the amendment applies to';
    if (!content.trim()) found.content = 'Write the amendment to add to the note';
    setErrors(found);
    if (Object.keys(found).length === 0) accept.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Accept the amendment"
      description="The amendment is added to the note as an addendum; the signed text isn't changed."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="accept-amendment" loading={accept.isPending}>
            Accept and add addendum
          </Button>
        </>
      }
    >
      <form id="accept-amendment" onSubmit={submit} noValidate className="space-y-4">
        <div className="rounded-lg border border-sage-200 bg-sage-50 px-3 py-2 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-sage-500">The client asked</p>
          <p className="whitespace-pre-wrap text-sage-900">{amendment.request}</p>
        </div>
        {amendment.note_id === null ? (
          <Field label="Note to amend" required error={errors.note} hint="Signed notes only. Psychotherapy notes can't be amended this way.">
            {(props) => (
              <Select
                {...props}
                value={noteId ?? ''}
                disabled={notes.isPending}
                onChange={(event) => setNoteId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">{notes.isPending ? 'Loading notes…' : 'Choose a note'}</option>
                {choices.map((note) => (
                  <option key={note.id} value={note.id}>
                    {note.title || 'Untitled note'} · {formatDate(note.appointment_starts_at ?? note.created_at, staff.time_zone)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <p className="text-sm text-sage-700">
            Adds to{' '}
            <Link to={`/portal/notes/${amendment.note_id}`} className="font-medium text-primary-700 hover:underline">
              {amendment.note_title || 'the note the client named'}
            </Link>
            .
          </p>
        )}
        <Field label="Amendment" required error={errors.content}>
          {(props) => (
            <Textarea
              {...props}
              rows={5}
              maxLength={MAX_ADDENDUM_CHARS}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

type Dialog = 'accept' | 'deny' | 'rebuttal' | null;

/**
 * One amendment request with its deadline and outcome. Open requests can be accepted or denied; a
 * denial the client disagreed with can get the practice's rebuttal.
 */
export function AmendmentItem({
  amendment,
  showClient = true,
  highlighted = false,
}: {
  amendment: AmendmentRequest;
  showClient?: boolean;
  /** The request a notification linked to: marked, scrolled to and focused. */
  highlighted?: boolean;
}) {
  const { staff } = useSession();
  const itemRef = useHighlight<HTMLLIElement>(highlighted);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const timeZone = staff.time_zone;
  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: recordKeys.all });
    toast.success(message);
    setDialog(null);
  };
  const deny = useMutation({
    mutationFn: (reason: string) => recordsApi.denyAmendment(amendment.id, reason),
    onSuccess: () => done('Amendment denied. The client was notified and can file a disagreement.'),
    onError: (error) => toast.error(error),
  });
  const rebut = useMutation({
    mutationFn: (text: string) => recordsApi.addRebuttal(amendment.id, text),
    onSuccess: () => done('Rebuttal added'),
    onError: (error) => toast.error(error),
  });
  const open = amendment.status === 'open';
  const canRebut = amendment.status === 'denied' && amendment.disagreement !== '' && amendment.rebuttal === '';

  return (
    <li
      ref={itemRef}
      tabIndex={highlighted ? -1 : undefined}
      aria-current={highlighted ? 'true' : undefined}
      className={`px-4 py-4 focus:outline-none sm:px-5 ${highlighted ? HIGHLIGHT_CLASSES : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {showClient && (
              <Link to={`/portal/clients/${amendment.client.id}`} className="font-medium text-sage-900 hover:underline">
                {fullName(amendment.client)}
              </Link>
            )}
            <Badge tone={STATUS_TONES[amendment.status]}>{AMENDMENT_STATUS_LABELS[amendment.status]}</Badge>
            {open && <Badge tone={dueTone(amendment.days_left)}>{dueText(amendment.days_left)}</Badge>}
            {canRebut && <Badge tone="warning">Disagreement filed</Badge>}
          </div>
          <p className="text-sage-600">
            Received {formatDateTime(amendment.received_at, timeZone)} · {REQUESTED_BY_LABELS[amendment.requested_by]} ·
            due {formatPlainDate(amendment.due_on)}
          </p>
          {amendment.note_id !== null && (
            <p className="text-sage-600">
              About{' '}
              <Link to={`/portal/notes/${amendment.note_id}`} className="text-primary-700 hover:underline">
                {amendment.note_title || `note #${amendment.note_id}`}
              </Link>
            </p>
          )}
          <p className="whitespace-pre-wrap text-sage-800">
            <span className="font-medium">Request:</span> {amendment.request}
          </p>
          {amendment.decided_at && (
            <p className="text-sage-700">
              {AMENDMENT_STATUS_LABELS[amendment.status]} {formatDateTime(amendment.decided_at, timeZone)}
              {amendment.decided_by && ` by ${amendment.decided_by.name}`}
            </p>
          )}
          {amendment.denial_reason && (
            <p className="whitespace-pre-wrap text-sage-700">
              <span className="font-medium">Reason for denial:</span> {amendment.denial_reason}
            </p>
          )}
          {amendment.disagreement && (
            <p className="whitespace-pre-wrap text-sage-700">
              <span className="font-medium">Client&apos;s statement of disagreement:</span> {amendment.disagreement}
            </p>
          )}
          {amendment.rebuttal && (
            <p className="whitespace-pre-wrap text-sage-700">
              <span className="font-medium">Practice&apos;s rebuttal:</span> {amendment.rebuttal}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {open && (
            <>
              <Button size="sm" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setDialog('accept')}>
                Accept
              </Button>
              <Button variant="ghost" size="sm" icon={<XCircle className="h-4 w-4" />} onClick={() => setDialog('deny')}>
                Deny
              </Button>
            </>
          )}
          {canRebut && (
            <Button
              variant="secondary"
              size="sm"
              icon={<MessageSquareReply className="h-4 w-4" />}
              onClick={() => setDialog('rebuttal')}
            >
              Add rebuttal
            </Button>
          )}
        </div>
      </div>

      {dialog === 'accept' && <AcceptAmendmentDialog amendment={amendment} onClose={() => setDialog(null)} />}
      <ReasonDialog
        open={dialog === 'deny'}
        title="Deny this amendment?"
        description="The client sees the reason and can file a statement of disagreement, which stays with their record."
        label="Reason for the denial"
        confirmLabel="Deny amendment"
        danger
        maxLength={MAX_DENIAL_CHARS}
        loading={deny.isPending}
        onSubmit={(reason) => deny.mutate(reason)}
        onCancel={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === 'rebuttal'}
        title="Respond to the disagreement"
        description="Your rebuttal is kept with the request and the client's statement, and included in later copies of the record."
        label="Rebuttal"
        confirmLabel="Add rebuttal"
        maxLength={MAX_REQUEST_CHARS}
        loading={rebut.isPending}
        onSubmit={(text) => rebut.mutate(text)}
        onCancel={() => setDialog(null)}
      />
    </li>
  );
}
