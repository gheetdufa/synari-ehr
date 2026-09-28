import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { ApiError } from '../../api/client';
import { clientKeys, clientsApi, type ClientDetail, type ClientUpdate } from '../../api/clients';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { useToast } from '../../ui/Toast';
import { changedFields, fieldErrors } from './formUtils';

/** PATCH a client and put the returned record straight into the cache. */
export function useUpdateClient(clientId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: ClientUpdate) => clientsApi.update(clientId, changes),
    onSuccess: (client) => {
      queryClient.setQueryData(clientKeys.detail(clientId), client);
      void queryClient.invalidateQueries({ queryKey: ['clients', 'list'] });
    },
  });
}

export interface DetailItem {
  label: string;
  value: ReactNode;
  wide?: boolean;
}

/** Shown in place of a field the API leaves out because of the viewer's role. */
export function NotAvailable() {
  return <span className="italic text-sage-500">Not available to your role</span>;
}

/** Read-only label/value grid for a chart section. */
export function DetailList({ items }: { items: DetailItem[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className={item.wide ? 'sm:col-span-2' : ''}>
          <dt className="text-xs font-medium uppercase tracking-wide text-sage-500">{item.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-sage-900">
            {item.value === '' || item.value === null || item.value === undefined || item.value === false ? (
              <span className="text-sage-400">Not set</span>
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface SectionForm<D> {
  draft: D;
  set: (patch: Partial<D>) => void;
  errors: Record<string, string>;
}

export interface SectionUpdate {
  update: ClientUpdate;
  errors?: Record<string, string>;
}

/**
 * A chart section with a view mode and, when `editable`, an Edit mode. Saving validates the
 * draft, then PATCHes only the fields that differ from the current record; server field errors
 * show inline.
 */
export function EditableSection<D>({
  title,
  description,
  editable,
  client,
  toDraft,
  toUpdate,
  normalize,
  view,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Whether the signed-in staff member may change this section. */
  editable: boolean;
  client: ClientDetail;
  toDraft: (client: ClientDetail) => D;
  toUpdate: (draft: D) => SectionUpdate;
  /** Tidy the draft before validating (for example, drop blank rows) so error indexes line up. */
  normalize?: (draft: D) => D;
  view: ReactNode;
  children: (form: SectionForm<D>) => ReactNode;
}) {
  const toast = useToast();
  const update = useUpdateClient(client.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<D>(() => toDraft(client));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing) {
      formRef.current?.querySelector<HTMLElement>('input, select, textarea, button[role="switch"]')?.focus();
    } else if (wasEditing.current) {
      editButtonRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  const start = () => {
    setDraft(toDraft(client));
    setErrors({});
    setEditing(true);
  };

  const cancel = () => {
    setErrors({});
    setEditing(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const tidy = normalize ? normalize(draft) : draft;
    setDraft(tidy);
    const { update: next, errors: found = {} } = toUpdate(tidy);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const changes = changedFields(client, next);
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }
    update.mutate(changes, {
      onSuccess: () => {
        toast.success(`${title} saved`);
        setEditing(false);
      },
      onError: (error) => {
        if (error instanceof ApiError && error.status === 409 && 'email' in changes) {
          setErrors({ email: error.message });
          return;
        }
        const serverErrors = fieldErrors(error);
        if (Object.keys(serverErrors).length > 0) setErrors(serverErrors);
        else toast.error(error);
      },
    });
  };

  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          editable &&
          !editing && (
            <Button
              ref={editButtonRef}
              variant="ghost"
              size="sm"
              icon={<Pencil className="h-3.5 w-3.5" />}
              onClick={start}
              aria-label={`Edit ${title.toLowerCase()}`}
            >
              Edit
            </Button>
          )
        }
      />
      <CardBody>
        {editable && editing ? (
          <form ref={formRef} onSubmit={submit} noValidate aria-label={`Edit ${title.toLowerCase()}`}>
            <div className="space-y-4">{children({ draft, set: (patch) => setDraft((d) => ({ ...d, ...patch })), errors })}</div>
            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-sage-100 pt-4">
              <Button variant="secondary" onClick={cancel} disabled={update.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={update.isPending}>
                Save
              </Button>
            </div>
          </form>
        ) : (
          view
        )}
      </CardBody>
    </Card>
  );
}
