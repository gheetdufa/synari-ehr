import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PenLine, Send } from 'lucide-react';
import { portalRecordKeys, portalRecordsApi, type PortalAmendmentRequest } from '../../api/portalRecords';
import { formatDate, formatPlainDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { ErrorState } from '../../ui/Display';
import { Field, Textarea } from '../../ui/Form';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { amendmentStatus } from './recordStatus';
import { StatusLine } from './StatusLine';

const MAX_TEXT = 5000;

function textProblem(value: string, missing: string): string | undefined {
  if (!value.trim()) return missing;
  if (value.trim().length > MAX_TEXT) return `Keep this under ${MAX_TEXT} characters`;
  return undefined;
}

function AmendmentForm() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();

  const create = useMutation({
    mutationFn: (request: string) => portalRecordsApi.requestAmendment(request),
    onSuccess: (created) => {
      toast.success(`Request sent. The practice will decide by ${formatPlainDate(created.due_on)}.`);
      setText('');
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: portalRecordKeys.amendments });
    },
    onError: (failure) => toast.error(failure),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = textProblem(text, 'Tell us what should be changed and why');
    setError(problem);
    if (!problem) create.mutate(text.trim());
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        label="What should be changed?"
        required
        error={error}
        hint="Say what’s wrong or missing, where it appears (for example the date of a session) and what it should say."
      >
        {(props) => (
          <Textarea
            {...props}
            rows={4}
            value={text}
            maxLength={MAX_TEXT}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>
      <div className="flex justify-end">
        <Button
          type="submit"
          icon={<Send className="h-4 w-4" />}
          loading={create.isPending}
          className="h-12 w-full px-6 text-base sm:w-auto"
        >
          Request a change
        </Button>
      </div>
    </form>
  );
}

function DisagreementForm({ amendment }: { amendment: PortalAmendmentRequest }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [error, setError] = useState<string | undefined>();

  const file = useMutation({
    mutationFn: (text: string) => portalRecordsApi.disagree(amendment.id, text),
    onSuccess: () => {
      toast.success('Your statement was added to your record.');
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: portalRecordKeys.amendments });
    },
    onError: (failure) => toast.error(failure),
  });

  if (!open) {
    return (
      <Button variant="secondary" size="sm" icon={<PenLine className="h-4 w-4" />} className="mt-3" onClick={() => setOpen(true)}>
        Submit a statement of disagreement
      </Button>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = textProblem(statement, 'Write your statement of disagreement');
    setError(problem);
    if (!problem) file.mutate(statement.trim());
  };

  return (
    <form onSubmit={submit} noValidate className="mt-3 space-y-3">
      <Field
        label="Statement of disagreement"
        required
        error={error}
        hint="Explain why you disagree. It’s kept with your record and included whenever that part of it is shared."
      >
        {(props) => (
          <Textarea
            {...props}
            rows={4}
            value={statement}
            maxLength={MAX_TEXT}
            onChange={(event) => setStatement(event.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={file.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={file.isPending}>
          Submit statement
        </Button>
      </div>
    </form>
  );
}

function AmendmentRow({ amendment, timeZone }: { amendment: PortalAmendmentRequest; timeZone: string }) {
  return (
    <li className="px-5 py-4 text-sm">
      <p className="font-medium text-sage-900">Requested {formatDate(amendment.received_at, timeZone)}</p>
      <p className="mt-0.5 whitespace-pre-line break-words text-sage-700">{amendment.request}</p>
      <StatusLine status={amendmentStatus(amendment, timeZone)} />
      {amendment.disagreement && (
        <div className="mt-3 rounded-lg bg-sage-50 px-3 py-2">
          <p className="text-xs font-semibold text-sage-700">Your statement of disagreement</p>
          <p className="mt-0.5 whitespace-pre-line break-words text-sage-800">{amendment.disagreement}</p>
        </div>
      )}
      {amendment.rebuttal && (
        <div className="mt-2 rounded-lg bg-sage-50 px-3 py-2">
          <p className="text-xs font-semibold text-sage-700">The practice’s response</p>
          <p className="mt-0.5 whitespace-pre-line break-words text-sage-800">{amendment.rebuttal}</p>
        </div>
      )}
      {amendment.can_disagree && <DisagreementForm amendment={amendment} />}
    </li>
  );
}

/** Ask the practice to correct the record, and follow up on earlier requests (amendments). */
export function AmendmentsSection({ timeZone }: { timeZone: string }) {
  const amendments = useQuery({ queryKey: portalRecordKeys.amendments, queryFn: portalRecordsApi.amendmentRequests });
  return (
    <Card>
      <CardHeader
        title="Request a change to my record"
        description="If you think something in your record is wrong or incomplete, you can ask the practice to change it. It decides within 60 days. If it says no, you can add a statement of disagreement to your record."
      />
      <CardBody>
        <AmendmentForm />
      </CardBody>
      {amendments.isPending && <SectionSpinner />}
      {amendments.error && <ErrorState error={amendments.error} onRetry={() => void amendments.refetch()} />}
      {amendments.data && amendments.data.length > 0 && (
        <div className="border-t border-sage-100">
          <h3 className="px-5 pt-4 text-sm font-semibold text-sage-800">Your requests</h3>
          <ul className="divide-y divide-sage-100" aria-label="Your change requests">
            {amendments.data.map((amendment) => (
              <AmendmentRow key={amendment.id} amendment={amendment} timeZone={timeZone} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
