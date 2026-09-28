import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, MessageSquareReply } from 'lucide-react';
import { MAX_COMMENT_CHARS, noteKeys, notesApi, type Note, type NoteSummary } from '../../../api/notes';
import { fullName } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Field, Textarea } from '../../../ui/Form';
import { ConfirmDialog, Modal } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';

/**
 * A supervisor's "Request changes" and "Co-sign" for a supervisee's note that waits for them.
 * Co-signing is confirmed; sending the note back needs a comment for its author.
 */
export function CosignActions({ note, size = 'md' }: { note: NoteSummary; size?: 'sm' | 'md' }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmCosign, setConfirmCosign] = useState(false);
  const [returning, setReturning] = useState(false);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const subject = `${note.author.name}'s note for ${fullName(note.client)}`;

  const settle = (updated: Note) => {
    queryClient.setQueryData(noteKeys.detail(note.id), updated);
    void queryClient.invalidateQueries({ queryKey: noteKeys.lists });
    void queryClient.invalidateQueries({ queryKey: noteKeys.cosignQueue });
    void queryClient.invalidateQueries({ queryKey: noteKeys.backlog });
  };

  const cosign = useMutation({
    mutationFn: () => notesApi.cosign(note.id),
    onSuccess: (updated) => {
      setConfirmCosign(false);
      settle(updated);
      toast.success(`Co-signed ${subject}.`);
    },
    onError: (error) => {
      setConfirmCosign(false);
      toast.error(error);
      void queryClient.invalidateQueries({ queryKey: noteKeys.cosignQueue });
    },
  });

  const requestChanges = useMutation({
    mutationFn: (text: string) => notesApi.requestChanges(note.id, text),
    onSuccess: (updated) => {
      setReturning(false);
      setComment('');
      settle(updated);
      toast.success(`Sent the note for ${fullName(note.client)} back to ${note.author.name}.`);
    },
    onError: (error) => toast.error(error),
  });

  const submitChanges = (event: FormEvent) => {
    event.preventDefault();
    const text = comment.trim();
    if (!text) {
      setCommentError('Tell the author what to change.');
      return;
    }
    setCommentError(null);
    requestChanges.mutate(text);
  };

  const busy = cosign.isPending || requestChanges.isPending;
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        icon={<MessageSquareReply className="h-4 w-4" />}
        disabled={busy}
        aria-label={`Request changes to ${subject}`}
        onClick={() => setReturning(true)}
      >
        Request changes
      </Button>
      <Button
        size={size}
        icon={<CheckCheck className="h-4 w-4" />}
        disabled={busy}
        aria-label={`Co-sign ${subject}`}
        onClick={() => setConfirmCosign(true)}
      >
        Co-sign
      </Button>

      <ConfirmDialog
        open={confirmCosign}
        title="Co-sign this note?"
        confirmLabel="Co-sign"
        loading={cosign.isPending}
        onConfirm={() => cosign.mutate()}
        onCancel={() => setConfirmCosign(false)}
        message={
          <div className="space-y-2">
            <p>
              Your co-signature is added to {subject} and the note becomes part of the clinical record.
            </p>
            <p className="text-sage-600">{note.author.name} will be notified.</p>
          </div>
        }
      />
      <Modal
        open={returning}
        onClose={() => setReturning(false)}
        title="Request changes"
        description={`The note for ${fullName(note.client)} goes back to ${note.author.name} as a draft with your comment. They sign it again when it's ready.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReturning(false)}>
              Cancel
            </Button>
            <Button type="submit" form={`request-changes-${note.id}`} loading={requestChanges.isPending}>
              Send back
            </Button>
          </>
        }
      >
        <form id={`request-changes-${note.id}`} onSubmit={submitChanges} noValidate>
          <Field label="Comment for the author" required error={commentError} hint="Only staff who can open this note see it.">
            {(props) => (
              <Textarea
                {...props}
                rows={5}
                value={comment}
                maxLength={MAX_COMMENT_CHARS}
                onChange={(event) => setComment(event.target.value)}
              />
            )}
          </Field>
        </form>
      </Modal>
    </>
  );
}
