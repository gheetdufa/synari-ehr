import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import {
  REVIEW_NOTE_MAX,
  emergencyAccessApi,
  emergencyAccessKeys,
  type EmergencyGrantReview,
} from '../../../api/emergencyAccess';
import { useSession } from '../../../auth/StaffAuth';
import { formatDateTime, formatTime } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card, CardHeader } from '../../../ui/Card';
import { Alert, Badge, EmptyState, ErrorState, Tabs } from '../../../ui/Display';
import { Field, Textarea } from '../../../ui/Form';
import { ConfirmDialog, Modal } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';

type Filter = 'pending' | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'pending', label: 'Needs review' },
  { id: 'all', label: 'All' },
];

type Dialog = { kind: 'review' | 'end'; grant: EmergencyGrantReview } | null;

function StatusBadge({ grant, timeZone }: { grant: EmergencyGrantReview; timeZone: string }) {
  if (grant.active) return <Badge tone="warning">Active until {formatTime(grant.expires_at, timeZone)}</Badge>;
  return <Badge>{grant.revoked_at ? 'Ended early' : 'Expired'}</Badge>;
}

function GrantRow({
  grant,
  timeZone,
  onReview,
  onEnd,
}: {
  grant: EmergencyGrantReview;
  timeZone: string;
  onReview: () => void;
  onEnd: () => void;
}) {
  return (
    <li className="space-y-2 px-5 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sage-900">
          <span className="font-medium">{grant.staff_name}</span> opened{' '}
          <Link to={`/portal/clients/${grant.client_id}`} className="font-medium text-primary-700 hover:underline">
            {grant.client_name}
          </Link>
          &apos;s chart
        </p>
        <StatusBadge grant={grant} timeZone={timeZone} />
        {grant.reviewed_at && <Badge tone="success">Reviewed</Badge>}
      </div>
      <p className="text-xs text-sage-500">
        <time dateTime={grant.created_at}>{formatDateTime(grant.created_at, timeZone)}</time>
      </p>
      <blockquote className="whitespace-pre-line rounded-lg bg-sage-50 px-3 py-2 text-sage-800">
        <span className="sr-only">Reason: </span>
        {grant.reason}
      </blockquote>
      {grant.reviewed_at && (
        <p className="text-xs text-sage-600">
          Reviewed by {grant.reviewed_by_name || 'an owner'} · {formatDateTime(grant.reviewed_at, timeZone)}
          {grant.review_note && <span className="block whitespace-pre-line text-sage-700">{grant.review_note}</span>}
        </p>
      )}
      {(!grant.reviewed_at || grant.active) && (
        <div className="flex flex-wrap gap-2">
          {!grant.reviewed_at && (
            <Button variant="secondary" size="sm" onClick={onReview}>
              Mark reviewed
            </Button>
          )}
          {grant.active && (
            <Button variant="ghost" size="sm" className="text-red-700 hover:bg-red-50" onClick={onEnd}>
              End access now
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function ReviewModal({ grant, onClose }: { grant: EmergencyGrantReview; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => emergencyAccessApi.markReviewed(grant.id, note.trim()),
    onMutate: () => setError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: emergencyAccessKeys.reviews });
      toast.success('Marked as reviewed');
      onClose();
    },
    onError: (err) => setError(err.message),
  });
  const close = () => !save.isPending && onClose();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title="Mark as reviewed"
      description={`${grant.staff_name} opened ${grant.client_name}'s chart.`}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="emergency-review-form" loading={save.isPending}>
            Mark reviewed
          </Button>
        </>
      }
    >
      <form id="emergency-review-form" onSubmit={submit} noValidate className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Review note" hint="Optional. For example, who you spoke with and what you found.">
          {(props) => (
            <Textarea {...props} rows={3} maxLength={REVIEW_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
          )}
        </Field>
      </form>
    </Modal>
  );
}

/** Owners review every use of emergency access, and can end one that is still open. */
export function EmergencyAccessReviewsCard() {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('pending');
  const [dialog, setDialog] = useState<Dialog>(null);
  const pendingOnly = filter === 'pending';
  const grants = useQuery({
    queryKey: emergencyAccessKeys.reviewList(pendingOnly),
    queryFn: () => emergencyAccessApi.reviews(pendingOnly),
  });

  const end = useMutation({
    mutationFn: (grant: EmergencyGrantReview) => emergencyAccessApi.revoke(grant.id),
    onSuccess: (grant) => {
      void queryClient.invalidateQueries({ queryKey: emergencyAccessKeys.reviews });
      setDialog(null);
      toast.success(`${grant.staff_name}'s emergency access has ended`);
    },
    onError: (error) => {
      setDialog(null);
      toast.error(error);
    },
  });

  const target = dialog?.grant;

  return (
    <Card>
      <CardHeader
        title="Emergency access reviews"
        description="Each time a clinician uses emergency access to open a chart outside their caseload. Review every one, and end any that shouldn't continue."
      />
      <div className="px-5 pt-2">
        <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />
      </div>
      {grants.isPending && <SectionSpinner />}
      {grants.isError && <ErrorState error={grants.error} onRetry={() => void grants.refetch()} />}
      {grants.data && grants.data.length === 0 && (
        <EmptyState
          icon={<ShieldCheck />}
          title={pendingOnly ? 'Nothing to review' : 'No emergency access yet'}
          description="When a clinician uses emergency access, it shows up here for review."
        />
      )}
      {grants.data && grants.data.length > 0 && (
        <ul className="divide-y divide-sage-100">
          {grants.data.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              timeZone={staff.time_zone}
              onReview={() => setDialog({ kind: 'review', grant })}
              onEnd={() => setDialog({ kind: 'end', grant })}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === 'review' && <ReviewModal grant={dialog.grant} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog?.kind === 'end'}
        title={`End ${target?.staff_name ?? ''}'s emergency access?`}
        message={`They lose access to ${target?.client_name ?? 'this client'}'s chart right away. You can still review this access afterwards.`}
        confirmLabel="End access now"
        danger
        loading={end.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => target && end.mutate(target)}
      />
    </Card>
  );
}
