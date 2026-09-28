import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarClock, CheckCircle2, Download, XCircle } from 'lucide-react';
import {
  MAX_DELIVERY_NOTE_CHARS,
  MAX_DENIAL_CHARS,
  MAX_REASON_CHARS,
  RECORD_DELIVERY_LABELS,
  REQUESTED_BY_LABELS,
  recordKeys,
  recordsApi,
  type RecordRequest,
} from '../../api/records';
import { useSession } from '../../auth/StaffAuth';
import { formatDateTime, formatPlainDate, fullName } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Display';
import { Field, Switch, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { ReasonDialog } from '../../ui/ReasonDialog';
import { useToast } from '../../ui/Toast';
import { HIGHLIGHT_CLASSES, RECORD_STATUS_LABELS, STATUS_TONES, dueText, dueTone, useHighlight } from './recordHelpers';

function FulfillDialog({ request, open, onClose }: { request: RecordRequest; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [includeBilling, setIncludeBilling] = useState(true);
  const [note, setNote] = useState('');
  const [downloading, setDownloading] = useState(false);
  const thirdParty = request.delivery === 'third_party';
  const fulfill = useMutation({
    mutationFn: () =>
      recordsApi.fulfill(request.id, { include_billing: includeBilling, ...(thirdParty ? { note: note.trim() } : {}) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: recordKeys.all });
      toast.success(thirdParty ? 'Recorded as sent' : 'Released in the client portal');
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const downloadPackage = async () => {
    setDownloading(true);
    try {
      await recordsApi.downloadPackage(request.id, includeBilling);
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={thirdParty ? 'Send the record to the recipient' : 'Release the record in the portal'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={fulfill.isPending} onClick={() => fulfill.mutate()}>
            {thirdParty ? 'Mark as sent' : 'Release to client'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-sage-700">
        {thirdParty ? (
          <>
            <p>
              Download the record, send it securely to the recipient the client named, then mark it as sent. The delivery
              is added to the client&apos;s accounting of disclosures.
            </p>
            <div className="rounded-lg border border-sage-200 bg-sage-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-sage-500">Recipient</p>
              <p className="whitespace-pre-wrap text-sage-900">{request.recipient}</p>
            </div>
          </>
        ) : (
          <p>
            The client&apos;s record is packaged and shared in their portal for 30 days. They get a notification that
            it&apos;s ready (without any details of the record).
          </p>
        )}
        <Switch
          label="Include billing records"
          description="Invoices, superbills and payments. They're included only if you have billing access to this client."
          checked={includeBilling}
          onChange={setIncludeBilling}
        />
        <p className="text-xs text-sage-500">Psychotherapy notes are never included.</p>
        {thirdParty && (
          <>
            <Button
              variant="secondary"
              icon={<Download className="h-4 w-4" />}
              loading={downloading}
              onClick={() => void downloadPackage()}
            >
              Download record
            </Button>
            <Field label="How it was sent" hint="For example: secure email to the address the client gave, or mailed.">
              {(props) => (
                <Textarea
                  {...props}
                  rows={2}
                  maxLength={MAX_DELIVERY_NOTE_CHARS}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              )}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

type Dialog = 'extend' | 'fulfill' | 'deny' | null;

/**
 * One request for a copy of a client's record, with its deadline and, while it's open, the
 * actions: extend once (with a reason the client is told), fulfill, or deny.
 */
export function RecordRequestItem({
  request,
  showClient = true,
  highlighted = false,
}: {
  request: RecordRequest;
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
  const extend = useMutation({
    mutationFn: (reason: string) => recordsApi.extend(request.id, reason),
    onSuccess: () => done('Deadline extended by 30 days'),
    onError: (error) => toast.error(error),
  });
  const deny = useMutation({
    mutationFn: (reason: string) => recordsApi.deny(request.id, reason),
    onSuccess: () => done('Request denied. The client was notified.'),
    onError: (error) => toast.error(error),
  });
  const open = request.status === 'open';

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
              <Link to={`/portal/clients/${request.client.id}`} className="font-medium text-sage-900 hover:underline">
                {fullName(request.client)}
              </Link>
            )}
            <Badge tone={STATUS_TONES[request.status]}>{RECORD_STATUS_LABELS[request.status]}</Badge>
            {open && <Badge tone={dueTone(request.days_left)}>{dueText(request.days_left)}</Badge>}
            {request.extended_on && <Badge tone="neutral">Extended</Badge>}
          </div>
          <p className="text-sage-600">
            Received {formatDateTime(request.received_at, timeZone)} · {REQUESTED_BY_LABELS[request.requested_by]} · due{' '}
            {formatPlainDate(request.due_on)}
          </p>
          <p className="text-sage-600">{RECORD_DELIVERY_LABELS[request.delivery]}</p>
          <p className="whitespace-pre-wrap text-sage-800">
            <span className="font-medium">Asked for:</span> {request.scope}
          </p>
          {request.delivery === 'third_party' && request.recipient && (
            <p className="whitespace-pre-wrap text-sage-800">
              <span className="font-medium">Send to:</span> {request.recipient}
            </p>
          )}
          {request.extension_reason && (
            <p className="text-sage-700">
              <span className="font-medium">Extension reason:</span> {request.extension_reason}
            </p>
          )}
          {request.status === 'fulfilled' && request.fulfilled_at && (
            <p className="text-sage-700">
              Fulfilled {formatDateTime(request.fulfilled_at, timeZone)}
              {request.fulfilled_by && ` by ${request.fulfilled_by.name}`}
              {request.release_expires_at &&
                (request.release_available
                  ? ` · available in the portal until ${formatDateTime(request.release_expires_at, timeZone)}`
                  : ' · the portal download has expired')}
            </p>
          )}
          {request.status === 'denied' && request.denial_reason && (
            <p className="text-sage-700">
              <span className="font-medium">Denied:</span> {request.denial_reason}
            </p>
          )}
        </div>
        {open && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setDialog('fulfill')}>
              Fulfill
            </Button>
            {!request.extended_on && (
              <Button
                variant="secondary"
                size="sm"
                icon={<CalendarClock className="h-4 w-4" />}
                onClick={() => setDialog('extend')}
              >
                Extend
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<XCircle className="h-4 w-4" />} onClick={() => setDialog('deny')}>
              Deny
            </Button>
          </div>
        )}
      </div>

      {dialog === 'fulfill' && <FulfillDialog request={request} open onClose={() => setDialog(null)} />}
      <ReasonDialog
        open={dialog === 'extend'}
        title="Extend the deadline by 30 days?"
        description="You can extend a request once. The client is told the reason and the new date."
        label="Reason for the extension"
        confirmLabel="Extend"
        maxLength={MAX_REASON_CHARS}
        loading={extend.isPending}
        onSubmit={(reason) => extend.mutate(reason)}
        onCancel={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === 'deny'}
        title="Deny this request?"
        description="Only deny for the reasons the law allows. The client sees the reason in their portal."
        label="Reason for the denial"
        confirmLabel="Deny request"
        danger
        maxLength={MAX_DENIAL_CHARS}
        loading={deny.isPending}
        onSubmit={(reason) => deny.mutate(reason)}
        onCancel={() => setDialog(null)}
      />
    </li>
  );
}
