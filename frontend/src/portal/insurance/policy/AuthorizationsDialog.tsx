import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Pencil, Plus, Trash2 } from 'lucide-react';
import { insuranceApi, insuranceKeys, type Authorization, type AuthorizationInput } from '../../../api/insurance';
import { useSession } from '../../../auth/StaffAuth';
import { formatPlainDate } from '../../../lib/format';
import { Button, IconButton } from '../../../ui/Button';
import { Alert, Badge, EmptyState, ErrorState } from '../../../ui/Display';
import { Field, Input, Textarea } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { fieldErrors } from '../../clients/formUtils';

interface AuthorizationDraft {
  number: string;
  start_date: string;
  end_date: string;
  visits_authorized: string;
  notes: string;
}

const EMPTY: AuthorizationDraft = { number: '', start_date: '', end_date: '', visits_authorized: '', notes: '' };

function draftFrom(authorization: Authorization | null): AuthorizationDraft {
  if (!authorization) return EMPTY;
  return {
    number: authorization.number,
    start_date: authorization.start_date,
    end_date: authorization.end_date,
    visits_authorized: authorization.visits_authorized === null ? '' : String(authorization.visits_authorized),
    notes: authorization.notes,
  };
}

/** Validate a draft; returns the API input or field errors. */
export function authorizationInput(draft: AuthorizationDraft): { input: AuthorizationInput | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const number = draft.number.trim();
  if (!number) errors.number = 'Enter the authorization number';
  else if (number.length > 50) errors.number = 'Use 50 characters or fewer';
  if (!draft.start_date) errors.start_date = 'Choose the first covered day';
  if (!draft.end_date) errors.end_date = 'Choose the last covered day';
  else if (draft.start_date && draft.end_date < draft.start_date) errors.end_date = 'The end date must be on or after the start date';
  const visits = draft.visits_authorized.trim();
  const count = visits ? Number(visits) : null;
  if (count !== null && (!Number.isInteger(count) || count < 0 || count > 10_000)) {
    errors.visits_authorized = 'Enter a whole number of visits';
  }
  if (Object.keys(errors).length > 0) return { input: null, errors };
  return {
    input: { number, start_date: draft.start_date, end_date: draft.end_date, visits_authorized: count, notes: draft.notes.trim() },
    errors,
  };
}

/** Today in a time zone, as YYYY-MM-DD. */
function today(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function AuthorizationStatus({ authorization, on }: { authorization: Authorization; on: string }) {
  if (on < authorization.start_date) return <Badge tone="info">Starts {formatPlainDate(authorization.start_date)}</Badge>;
  if (on > authorization.end_date) return <Badge>Expired</Badge>;
  const { visits_authorized: allowed, visits_used: used } = authorization;
  if (allowed !== null && used >= allowed) return <Badge tone="danger">All visits used</Badge>;
  if (allowed !== null && allowed - used <= 2) return <Badge tone="warning">{allowed - used} left</Badge>;
  return <Badge tone="success">Active</Badge>;
}

function VisitsUsed({ authorization }: { authorization: Authorization }) {
  const { visits_authorized: allowed, visits_used: used } = authorization;
  if (allowed === null) return <p className="text-xs text-sage-500">{used} billed · no visit limit</p>;
  const percent = allowed === 0 ? 100 : Math.min(100, Math.round((used / allowed) * 100));
  return (
    <div className="mt-1">
      <p className="text-xs text-sage-600">
        {used} of {allowed} visits billed
      </p>
      <div
        role="progressbar"
        aria-label="Visits used"
        aria-valuemin={0}
        aria-valuemax={allowed}
        aria-valuenow={Math.min(used, allowed)}
        className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-sage-100"
      >
        <div className={`h-full ${used >= allowed ? 'bg-red-500' : 'bg-primary-500'}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function AuthorizationForm({
  authorization,
  saving,
  serverErrors,
  onSave,
  onCancel,
}: {
  authorization: Authorization | null;
  saving: boolean;
  serverErrors: Record<string, string>;
  onSave: (input: AuthorizationInput) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AuthorizationDraft>(() => draftFrom(authorization));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<AuthorizationDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const shown = { ...serverErrors, ...errors };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { input, errors: found } = authorizationInput(draft);
    setErrors(found);
    if (input) onSave(input);
  };

  return (
    <form onSubmit={submit} noValidate aria-label={authorization ? 'Edit authorization' : 'New authorization'} className="space-y-3 rounded-xl border border-primary-100 bg-primary-50/30 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Authorization number" required error={shown.number}>
          {(props) => <Input {...props} maxLength={50} value={draft.number} onChange={(e) => set({ number: e.target.value })} />}
        </Field>
        <Field label="Visits authorized" hint="Leave blank if there's no visit limit" error={shown.visits_authorized}>
          {(props) => (
            <Input {...props} inputMode="numeric" value={draft.visits_authorized} onChange={(e) => set({ visits_authorized: e.target.value })} />
          )}
        </Field>
        <Field label="Start date" required error={shown.start_date}>
          {(props) => <Input {...props} type="date" value={draft.start_date} onChange={(e) => set({ start_date: e.target.value })} />}
        </Field>
        <Field label="End date" required error={shown.end_date}>
          {(props) => <Input {...props} type="date" value={draft.end_date} onChange={(e) => set({ end_date: e.target.value })} />}
        </Field>
      </div>
      <Field label="Notes" hint="Services covered, who approved it. Don't include clinical details.">
        {(props) => <Textarea {...props} rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {authorization ? 'Save authorization' : 'Add authorization'}
        </Button>
      </div>
    </form>
  );
}

type Editing = { authorization: Authorization | null } | null;

/** A policy's prior authorizations: dates, visits billed against each, add, edit and remove. */
export function AuthorizationsDialog({
  policyId,
  payerName,
  clientName,
  onClose,
}: {
  policyId: number;
  payerName: string;
  clientName?: string;
  onClose: () => void;
}) {
  const { practice } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: insuranceKeys.authorizations(policyId), queryFn: () => insuranceApi.authorizations(policyId) });
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Authorization | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const on = today(practice.time_zone);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: insuranceKeys.authorizations(policyId) });
    void queryClient.invalidateQueries({ queryKey: ['clients', 'insurance'] });
  };

  const save = useMutation({
    mutationFn: ({ authorization, input }: { authorization: Authorization | null; input: AuthorizationInput }) =>
      authorization
        ? insuranceApi.updateAuthorization(policyId, authorization.id, input)
        : insuranceApi.createAuthorization(policyId, input),
    onSuccess: (_, { authorization }) => {
      refresh();
      toast.success(authorization ? 'Authorization updated' : 'Authorization added');
      setEditing(null);
    },
    onError: (error) => {
      const found = fieldErrors(error);
      if (Object.keys(found).length > 0) setServerErrors(found);
      else setFormError(error.message);
    },
  });

  const remove = useMutation({
    mutationFn: (authorization: Authorization) => insuranceApi.deleteAuthorization(policyId, authorization.id),
    onSuccess: () => {
      refresh();
      toast.success('Authorization removed');
      setDeleting(null);
    },
    onError: (error) => {
      toast.error(error);
      setDeleting(null);
    },
  });

  const open = (authorization: Authorization | null) => {
    setServerErrors({});
    setFormError(null);
    setEditing({ authorization });
  };

  const authorizations = list.data ?? [];

  return (
    <Modal
      open
      onClose={() => !save.isPending && onClose()}
      size="lg"
      title={`${payerName} authorizations`}
      description={clientName}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        {list.isPending && <SectionSpinner />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && authorizations.length === 0 && !editing && (
          <EmptyState
            icon={<ClipboardCheck />}
            title="No prior authorizations"
            description="Record an authorization so its number goes on claims for sessions in its date range."
          />
        )}
        {authorizations.length > 0 && (
          <ul className="divide-y divide-sage-100 rounded-xl border border-sage-100">
            {authorizations.map((authorization) =>
              editing?.authorization?.id === authorization.id ? (
                <li key={authorization.id} className="p-2">
                  <AuthorizationForm
                    authorization={authorization}
                    saving={save.isPending}
                    serverErrors={serverErrors}
                    onSave={(input) => save.mutate({ authorization, input })}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : deleting?.id === authorization.id ? (
                <li key={authorization.id} className="flex flex-wrap items-center justify-between gap-3 bg-red-50/60 px-4 py-3">
                  <p className="text-sm text-sage-900">
                    Remove authorization <strong>{authorization.number}</strong>? Claims already created keep its number.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(null)} disabled={remove.isPending}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(authorization)}>
                      Remove
                    </Button>
                  </div>
                </li>
              ) : (
                <li key={authorization.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-sage-900">
                      {authorization.number}
                      <AuthorizationStatus authorization={authorization} on={on} />
                    </p>
                    <p className="text-sm text-sage-600">
                      {formatPlainDate(authorization.start_date)} – {formatPlainDate(authorization.end_date)}
                    </p>
                    <VisitsUsed authorization={authorization} />
                    {authorization.notes && <p className="mt-1 text-xs text-sage-500">{authorization.notes}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <IconButton label={`Edit authorization ${authorization.number}`} onClick={() => open(authorization)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={`Remove authorization ${authorization.number}`}
                      onClick={() => setDeleting(authorization)}
                      className="hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
        {editing && editing.authorization === null ? (
          <AuthorizationForm
            authorization={null}
            saving={save.isPending}
            serverErrors={serverErrors}
            onSave={(input) => save.mutate({ authorization: null, input })}
            onCancel={() => setEditing(null)}
          />
        ) : (
          list.data && (
            <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => open(null)}>
              Add authorization
            </Button>
          )
        )}
      </div>
    </Modal>
  );
}
