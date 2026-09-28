import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileArchive, Send } from 'lucide-react';
import {
  portalRecordKeys,
  portalRecordsApi,
  type PortalRecordRequest,
  type RecordDelivery,
  type RecordRequestInput,
} from '../../api/portalRecords';
import { formatDate, formatPlainDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { ErrorState } from '../../ui/Display';
import { Field, Textarea } from '../../ui/Form';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { recordRequestStatus } from './recordStatus';
import { StatusLine } from './StatusLine';

const MAX_SCOPE = 2000;
const MAX_RECIPIENT = 1000;

const DELIVERY_OPTIONS: { id: RecordDelivery; label: string; description: string }[] = [
  { id: 'portal', label: 'Download it here in my portal', description: 'We’ll let you know when your copy is ready.' },
  {
    id: 'third_party',
    label: 'Send it to someone else',
    description: 'For example another provider, a lawyer or a family member you choose.',
  },
];

function DeliveryChoice({ value, onChange }: { value: RecordDelivery; onChange: (value: RecordDelivery) => void }) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 block text-sm font-medium text-sage-800">How should we get it to you?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {DELIVERY_OPTIONS.map((option) => (
          <label
            key={option.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 text-sm transition-colors ${
              value === option.id ? 'border-primary-400 bg-primary-50' : 'border-sage-200 hover:bg-sage-50'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
              className="mt-0.5 h-4 w-4 border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
            />
            <span>
              <span className="font-medium text-sage-900">{option.label}</span>
              <span className="block text-xs text-sage-600">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface FormErrors {
  scope?: string;
  recipient?: string;
}

function validate(scope: string, delivery: RecordDelivery, recipient: string): FormErrors {
  const errors: FormErrors = {};
  if (!scope.trim()) errors.scope = 'Tell us what you’d like a copy of';
  else if (scope.trim().length > MAX_SCOPE) errors.scope = `Keep this under ${MAX_SCOPE} characters`;
  if (delivery === 'third_party') {
    if (!recipient.trim()) errors.recipient = 'Tell us who to send it to and where';
    else if (recipient.trim().length > MAX_RECIPIENT) errors.recipient = `Keep this under ${MAX_RECIPIENT} characters`;
  }
  return errors;
}

function RequestCopyForm() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [scope, setScope] = useState('');
  const [delivery, setDelivery] = useState<RecordDelivery>('portal');
  const [recipient, setRecipient] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});

  const request = useMutation({
    mutationFn: (input: RecordRequestInput) => portalRecordsApi.requestRecord(input),
    onSuccess: (created) => {
      toast.success(`Request sent. The practice will respond by ${formatPlainDate(created.due_on)}.`);
      setScope('');
      setRecipient('');
      setDelivery('portal');
      setErrors({});
      void queryClient.invalidateQueries({ queryKey: portalRecordKeys.requests });
    },
    onError: (error) => toast.error(error),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(scope, delivery, recipient);
    setErrors(found);
    if (found.scope || found.recipient) return;
    request.mutate({
      scope: scope.trim(),
      delivery,
      ...(delivery === 'third_party' ? { recipient: recipient.trim() } : {}),
    });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="What would you like a copy of?" required error={errors.scope}>
        {(props) => (
          <Textarea
            {...props}
            rows={3}
            value={scope}
            maxLength={MAX_SCOPE}
            onChange={(event) => setScope(event.target.value)}
            placeholder="For example: my complete record, or my records from 2025"
          />
        )}
      </Field>
      <DeliveryChoice value={delivery} onChange={setDelivery} />
      {delivery === 'third_party' && (
        <Field
          label="Who should we send it to?"
          required
          error={errors.recipient}
          hint="Their name and mailing address, fax number or email address."
        >
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              value={recipient}
              maxLength={MAX_RECIPIENT}
              onChange={(event) => setRecipient(event.target.value)}
            />
          )}
        </Field>
      )}
      <div className="flex justify-end">
        <Button
          type="submit"
          icon={<Send className="h-4 w-4" />}
          loading={request.isPending}
          className="h-12 w-full px-6 text-base sm:w-auto"
        >
          Request a copy
        </Button>
      </div>
    </form>
  );
}

function RequestRow({ request, timeZone }: { request: PortalRecordRequest; timeZone: string }) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      await portalRecordsApi.downloadRelease(request.id);
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
      <FileArchive aria-hidden="true" className="hidden h-5 w-5 shrink-0 text-primary-700 sm:block" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sage-900">Requested {formatDate(request.received_at, timeZone)}</p>
        <p className="mt-0.5 whitespace-pre-line break-words text-sm text-sage-700">{request.scope}</p>
        {request.delivery === 'third_party' && (
          <p className="mt-0.5 whitespace-pre-line break-words text-sm text-sage-600">To: {request.recipient}</p>
        )}
        <StatusLine status={recordRequestStatus(request, timeZone)} />
      </div>
      {request.release_available && (
        <Button
          variant="secondary"
          icon={<Download className="h-4 w-4" />}
          loading={downloading}
          onClick={() => void download()}
          className="h-11 w-full shrink-0 sm:w-auto"
        >
          Download
        </Button>
      )}
    </li>
  );
}

/** Ask for a copy of the record and follow earlier requests (right of access). */
export function RecordRequestsSection({ timeZone }: { timeZone: string }) {
  const requests = useQuery({ queryKey: portalRecordKeys.requests, queryFn: portalRecordsApi.recordRequests });
  return (
    <Card>
      <CardHeader
        title="Request a copy of my record"
        description="You can ask for a copy of your record at any time. The practice has 30 days to respond, and can take one 30-day extension if it tells you why."
      />
      <CardBody>
        <RequestCopyForm />
      </CardBody>
      {requests.isPending && <SectionSpinner />}
      {requests.error && <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />}
      {requests.data && requests.data.length > 0 && (
        <div className="border-t border-sage-100">
          <h3 className="px-5 pt-4 text-sm font-semibold text-sage-800">Your requests</h3>
          <ul className="divide-y divide-sage-100" aria-label="Your record requests">
            {requests.data.map((request) => (
              <RequestRow key={request.id} request={request} timeZone={timeZone} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
