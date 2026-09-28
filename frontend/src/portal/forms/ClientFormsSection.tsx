import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, ClipboardList, Download, Eye, Flag, Lock, Send, Undo2 } from 'lucide-react';
import type { ClientDetail } from '../../api/clients';
import { FORM_KIND_LABELS, formKeys, formsApi, type ClientFormSummary } from '../../api/forms';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatDate } from '../../lib/format';
import { useRealtimeEvent } from '../../lib/realtime';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, EmptyState, ErrorState } from '../../ui/Display';
import { ConfirmDialog } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { ClientFormViewModal } from './ClientFormViewModal';
import { FormStatusBadge } from './FormStatusBadge';
import { ShareFormsModal } from './ShareFormsModal';

/** What the signed-in staff member may do with one client's shared forms. */
interface FormPermissions {
  /** Answers, scores and PDFs are clinical: only for staff with clinical access to the client. */
  seesResults: boolean;
  /** Reminders and withdrawals are for the client's clinicians and staff who schedule for everyone. */
  canFollowUp: boolean;
}

function useFormPermissions(client: ClientDetail): FormPermissions {
  const { staff } = useSession();
  const schedulesAll = useCan('schedule_all');
  return {
    seesResults: client.access.clinical,
    canFollowUp: schedulesAll || client.care_team.some((member) => member.staff_id === staff.id),
  };
}

function FormRow({
  form,
  timeZone,
  permissions,
  onView,
  onDownload,
  downloading,
  onRemind,
  reminding,
  onWithdraw,
}: {
  form: ClientFormSummary;
  timeZone: string;
  permissions: FormPermissions;
  onView: () => void;
  onDownload: () => void;
  downloading: boolean;
  onRemind: () => void;
  reminding: boolean;
  onWithdraw: () => void;
}) {
  const pending = form.status === 'pending';
  const resultsHidden = form.flagged === null;
  const dates = [
    `Sent ${formatDate(form.sent_at, timeZone)}`,
    form.viewed_at && pending ? `viewed ${formatDate(form.viewed_at, timeZone)}` : '',
    form.completed_at ? `completed ${formatDate(form.completed_at, timeZone)}` : '',
  ].filter(Boolean);
  const showView = permissions.seesResults;
  const showDownload = permissions.seesResults && !pending;
  const showFollowUp = permissions.canFollowUp && pending;
  return (
    <li className={`flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center ${form.flagged ? 'border-l-4 border-l-red-500 bg-red-50/40' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sage-900">{form.name}</p>
          <FormStatusBadge form={form} />
          {form.flagged && (
            <Badge tone="danger">
              <Flag aria-hidden="true" className="h-3 w-3" /> Needs review
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-sage-600">
          {FORM_KIND_LABELS[form.kind]} · {dates.join(', ')}
        </p>
        {form.score !== null && (
          <p className="mt-1 text-sm text-sage-800">
            <span className="font-semibold tabular-nums">Score {form.score}</span>
            {form.score_label && <span> · {form.score_label}</span>}
          </p>
        )}
        {!pending && resultsHidden && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-sage-500">
            <Lock aria-hidden="true" className="h-3.5 w-3.5" /> Results visible to the care team
          </p>
        )}
        {pending && form.reminder_count > 0 && form.last_reminded_at && (
          <p className="mt-1 text-xs text-sage-500">
            {form.reminder_count === 1 ? 'Reminder sent' : `${form.reminder_count} reminders sent`}, last on{' '}
            {formatDate(form.last_reminded_at, timeZone)}
          </p>
        )}
      </div>
      {(showView || showDownload || showFollowUp) && (
        <div className="flex flex-wrap gap-2">
          {showView && (
            <Button size="sm" variant="secondary" icon={<Eye className="h-4 w-4" />} onClick={onView} aria-label={`View ${form.name}`}>
              View
            </Button>
          )}
          {showDownload && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Download className="h-4 w-4" />}
              loading={downloading}
              onClick={onDownload}
              aria-label={`Download ${form.name} as PDF`}
            >
              PDF
            </Button>
          )}
          {showFollowUp && (
            <Button
              size="sm"
              variant="ghost"
              icon={<BellRing className="h-4 w-4" />}
              loading={reminding}
              onClick={onRemind}
              aria-label={`Send a reminder about ${form.name}`}
            >
              Remind
            </Button>
          )}
          {showFollowUp && (
            <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={onWithdraw} aria-label={`Withdraw ${form.name}`}>
              Withdraw
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The forms shared with one client: status for everyone who can see the client, and scores,
 * flags and answers for staff with clinical access, with sharing and follow-up actions.
 */
export function ClientFormsSection({ client, timeZone }: { client: ClientDetail; timeZone: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const permissions = useFormPermissions(client);
  const [shareOpen, setShareOpen] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [withdrawing, setWithdrawing] = useState<ClientFormSummary | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);
  const clientId = client.id;
  const forms = useQuery({ queryKey: formKeys.clientForms(clientId), queryFn: () => formsApi.clientForms(clientId) });

  useRealtimeEvent(['client_form.completed', 'client_form.viewed'], (event) => {
    if (event.data.client_id !== clientId) return;
    void queryClient.invalidateQueries({ queryKey: formKeys.clientForms(clientId) });
    if (typeof event.data.client_form_id === 'number') {
      void queryClient.invalidateQueries({ queryKey: formKeys.clientForm(event.data.client_form_id) });
    }
  });

  const remind = useMutation({
    mutationFn: (form: ClientFormSummary) => formsApi.remind(form.id),
    onSuccess: (result) => {
      toast.success(result.detail);
      void queryClient.invalidateQueries({ queryKey: formKeys.clientForms(clientId) });
    },
    onError: (error) => toast.error(error),
  });

  const withdraw = useMutation({
    mutationFn: (form: ClientFormSummary) => formsApi.withdraw(form.id),
    onSuccess: (_, form) => {
      toast.success(`${form.name} withdrawn`);
      setWithdrawing(null);
      queryClient.removeQueries({ queryKey: formKeys.clientForm(form.id) });
      void queryClient.invalidateQueries({ queryKey: formKeys.clientForms(clientId) });
    },
    onError: (error) => {
      toast.error(error);
      void queryClient.invalidateQueries({ queryKey: formKeys.clientForms(clientId) });
    },
  });

  const download = async (form: ClientFormSummary) => {
    setDownloading(form.id);
    try {
      await formsApi.downloadPdf(form.id);
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(null);
    }
  };

  const list = forms.data ?? [];
  const pendingCount = list.filter((form) => form.status === 'pending').length;
  const flaggedCount = list.filter((form) => form.flagged === true).length;

  return (
    <Card>
      <CardHeader
        title="Forms"
        description={
          list.length
            ? [
                `${pendingCount} waiting on the client`,
                flaggedCount ? `${flaggedCount} need${flaggedCount === 1 ? 's' : ''} review` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : 'Intake questionnaires, consents and assessments'
        }
        actions={
          <Button size="sm" icon={<Send className="h-4 w-4" />} onClick={() => setShareOpen(true)}>
            Share forms
          </Button>
        }
      />
      {forms.isPending && <SectionSpinner />}
      {forms.error && <ErrorState error={forms.error} onRetry={() => void forms.refetch()} />}
      {forms.data && list.length === 0 && (
        <EmptyState
          icon={<ClipboardList />}
          title="No forms shared yet"
          description="Send intake and consent forms for the client to complete in their portal before the first session."
          action={
            <Button icon={<Send className="h-4 w-4" />} onClick={() => setShareOpen(true)}>
              Share forms
            </Button>
          }
        />
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-sage-100">
          {list.map((form) => (
            <FormRow
              key={form.id}
              form={form}
              timeZone={timeZone}
              permissions={permissions}
              onView={() => setViewing(form.id)}
              onDownload={() => void download(form)}
              downloading={downloading === form.id}
              onRemind={() => remind.mutate(form)}
              reminding={remind.isPending && remind.variables?.id === form.id}
              onWithdraw={() => setWithdrawing(form)}
            />
          ))}
        </ul>
      )}

      {shareOpen && (
        <ShareFormsModal open onClose={() => setShareOpen(false)} client={client} existingForms={list} timeZone={timeZone} />
      )}
      {permissions.seesResults && (
        <ClientFormViewModal formId={viewing} onClose={() => setViewing(null)} timeZone={timeZone} />
      )}
      <ConfirmDialog
        open={withdrawing !== null}
        title="Withdraw this form?"
        message={`${withdrawing?.name ?? 'The form'} will be removed from the client's portal. You can share it again later.`}
        confirmLabel="Withdraw"
        danger
        loading={withdraw.isPending}
        onCancel={() => setWithdrawing(null)}
        onConfirm={() => withdrawing && withdraw.mutate(withdrawing)}
      />
    </Card>
  );
}
