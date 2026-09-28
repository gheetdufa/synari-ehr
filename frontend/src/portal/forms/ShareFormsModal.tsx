import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import type { ClientDetail } from '../../api/clients';
import {
  FORM_KINDS,
  FORM_KIND_LABELS,
  MAX_FORMS_PER_SHARE,
  formKeys,
  formsApi,
  type ClientFormSummary,
  type TemplateSummary,
} from '../../api/forms';
import { formatDate } from '../../lib/format';
import { Button, LinkButton } from '../../ui/Button';
import { Alert, EmptyState, ErrorState } from '../../ui/Display';
import { Checkbox } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { portalAccessProblem } from './portalAccess';

/** Templates preselected for a client who hasn't been sent anything yet: intake and consents. */
export function defaultSelection(templates: TemplateSummary[], existingForms: ClientFormSummary[]): Set<number> {
  if (existingForms.length > 0) return new Set();
  return new Set(
    templates
      .filter((template) => template.kind === 'intake' || template.kind === 'consent')
      .slice(0, MAX_FORMS_PER_SHARE)
      .map((template) => template.id),
  );
}

function historyNote(template: TemplateSummary, forms: ClientFormSummary[], timeZone: string): string {
  const latest = forms.find((form) => form.template_id === template.id);
  if (!latest) return '';
  if (latest.status === 'completed' && latest.completed_at) return `Completed ${formatDate(latest.completed_at, timeZone)}`;
  return `Sent ${formatDate(latest.sent_at, timeZone)}, not completed yet`;
}

/** Pick templates to send to a client's portal; they get one email with a sign-in link. */
export function ShareFormsModal({
  open,
  onClose,
  client,
  existingForms,
  timeZone,
}: {
  open: boolean;
  onClose: () => void;
  client: ClientDetail;
  existingForms: ClientFormSummary[];
  timeZone: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selection, setSelection] = useState<Set<number> | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const templates = useQuery({ queryKey: formKeys.templates, queryFn: formsApi.templates, enabled: open });

  const list = templates.data ?? [];
  const selected = selection ?? defaultSelection(list, existingForms);
  const accessProblem = portalAccessProblem(client);
  const tooMany = selected.size > MAX_FORMS_PER_SHARE;

  const share = useMutation({
    mutationFn: (templateIds: number[]) => formsApi.share(client.id, templateIds),
    onSuccess: (forms) => {
      void queryClient.invalidateQueries({ queryKey: formKeys.clientForms(client.id) });
      toast.success(
        `Sent ${forms.length} ${forms.length === 1 ? 'form' : 'forms'}${client.email ? `. ${client.email} will get an email with a link.` : '.'}`,
      );
      onClose();
    },
    onError: (error) => setServerError(error instanceof Error ? error.message : 'The forms could not be sent.'),
  });

  const toggle = (templateId: number) => {
    const next = new Set(selected);
    if (next.has(templateId)) next.delete(templateId);
    else next.add(templateId);
    setSelection(next);
    setServerError(null);
  };

  const ordered = list.filter((template) => selected.has(template.id)).map((template) => template.id);
  const blockingProblem = accessProblem ?? serverError;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Share forms"
      description={`${client.preferred_name || client.first_name} completes these in their client portal.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            icon={<Send className="h-4 w-4" />}
            loading={share.isPending}
            disabled={ordered.length === 0 || tooMany || Boolean(accessProblem)}
            onClick={() => {
              setServerError(null);
              share.mutate(ordered);
            }}
          >
            {ordered.length ? `Send ${ordered.length} ${ordered.length === 1 ? 'form' : 'forms'}` : 'Send'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {blockingProblem && (
          <Alert tone="danger" title="Forms can't be sent yet">
            <p>{blockingProblem}</p>
            <Link to={`/portal/clients/${client.id}`} onClick={onClose} className="mt-1 inline-block font-medium underline">
              Open client details
            </Link>
          </Alert>
        )}
        {tooMany && <Alert tone="warning">You can send up to {MAX_FORMS_PER_SHARE} forms at a time.</Alert>}
        {templates.isPending && <SectionSpinner />}
        {templates.error && <ErrorState error={templates.error} onRetry={() => void templates.refetch()} />}
        {templates.data && list.length === 0 && (
          <EmptyState
            title="No form templates yet"
            description="Add the built-in intake and consent forms from the library, or build your own."
            action={
              <LinkButton to="/portal/forms" onClick={onClose}>
                Go to forms
              </LinkButton>
            }
          />
        )}
        {FORM_KINDS.map((kind) => {
          const items = list.filter((template) => template.kind === kind);
          if (!items.length) return null;
          return (
            <fieldset key={kind}>
              <legend className="text-xs font-semibold uppercase tracking-wide text-sage-500">{FORM_KIND_LABELS[kind]}</legend>
              <div className="mt-2 space-y-1">
                {items.map((template) => {
                  const note = historyNote(template, existingForms, timeZone);
                  const details = [template.requires_signature ? 'Signature required' : '', note].filter(Boolean).join(' · ');
                  return (
                    <div key={template.id} className="rounded-lg px-2 py-2 hover:bg-sage-50">
                      <Checkbox
                        label={template.name}
                        description={details || undefined}
                        checked={selected.has(template.id)}
                        onChange={() => toggle(template.id)}
                      />
                    </div>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Modal>
  );
}
