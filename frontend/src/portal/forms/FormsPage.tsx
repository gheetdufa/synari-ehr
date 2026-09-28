import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ClipboardList, Copy, Eye, Library, Lock, Pencil, PenLine, Plus } from 'lucide-react';
import {
  FORM_KINDS,
  FORM_KIND_LABELS,
  formKeys,
  formsApi,
  type FormKind,
  type TemplateSummary,
} from '../../api/forms';
import { Button, LinkButton } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, EmptyState, ErrorState, PageHeader } from '../../ui/Display';
import { ConfirmDialog } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { LibraryModal } from './LibraryModal';
import { NewTemplateModal } from './NewTemplateModal';
import { useCanEditTemplates, useDuplicateTemplate } from './useTemplateActions';

const KIND_DESCRIPTIONS: Record<FormKind, string> = {
  intake: 'Questionnaires new clients complete before their first session',
  consent: 'Agreements and policies clients read and sign',
  assessment: 'Measures such as the PHQ-9 and GAD-7',
  other: 'Everything else',
};

function TemplateRow({
  template,
  canEdit,
  onDuplicate,
  duplicating,
  onArchive,
}: {
  template: TemplateSummary;
  canEdit: boolean;
  onDuplicate: () => void;
  duplicating: boolean;
  onArchive: () => void;
}) {
  const to = `/portal/forms/templates/${template.id}`;
  const editable = canEdit && !template.read_only;
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={to} className="font-medium text-sage-900 hover:text-primary-700 hover:underline">
            {template.name}
          </Link>
          {template.requires_signature && (
            <Badge tone="primary">
              <PenLine aria-hidden="true" className="h-3 w-3" /> Signature
            </Badge>
          )}
          {template.library_key && <Badge>Built-in</Badge>}
          {template.read_only && (
            <Badge tone="warning">
              <Lock aria-hidden="true" className="h-3 w-3" /> Read-only
            </Badge>
          )}
        </div>
        {template.description && <p className="mt-1 line-clamp-2 text-sm text-sage-600">{template.description}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <LinkButton
          to={to}
          size="sm"
          variant="secondary"
          icon={editable ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          aria-label={`${editable ? 'Edit' : 'View'} ${template.name}`}
        >
          {editable ? 'Edit' : 'View'}
        </LinkButton>
        {canEdit && (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy className="h-4 w-4" />}
              loading={duplicating}
              onClick={onDuplicate}
              aria-label={`Duplicate ${template.name}`}
            >
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Archive className="h-4 w-4" />}
              onClick={onArchive}
              aria-label={`Archive ${template.name}`}
            >
              Archive
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** /portal/forms — the practice's form templates grouped by kind. */
export default function FormsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [archiving, setArchiving] = useState<TemplateSummary | null>(null);
  const templates = useQuery({ queryKey: formKeys.templates, queryFn: formsApi.templates });
  const duplicate = useDuplicateTemplate();
  const canEdit = useCanEditTemplates();

  const archive = useMutation({
    mutationFn: (template: TemplateSummary) => formsApi.archiveTemplate(template.id),
    onSuccess: (_, template) => {
      queryClient.removeQueries({ queryKey: formKeys.template(template.id) });
      void queryClient.invalidateQueries({ queryKey: formKeys.templates });
      toast.success(`${template.name} archived`);
      setArchiving(null);
    },
    onError: (error) => toast.error(error),
  });

  const list = templates.data ?? [];
  const groups = FORM_KINDS.map((kind) => ({ kind, items: list.filter((template) => template.kind === kind) })).filter(
    (group) => group.items.length > 0,
  );

  return (
    <div>
      <PageHeader
        title="Forms"
        description={
          canEdit
            ? 'Intake questionnaires, consents and assessments you can share with clients to complete in their portal.'
            : "The practice's intake questionnaires, consents and assessments. Clinicians and practice managers maintain these templates."
        }
        actions={
          canEdit && (
            <>
              <Button variant="secondary" icon={<Library className="h-4 w-4" />} onClick={() => setLibraryOpen(true)}>
                Add from library
              </Button>
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>
                New template
              </Button>
            </>
          )
        }
      />

      {templates.isPending && <SectionSpinner />}
      {templates.error && (
        <Card>
          <ErrorState error={templates.error} onRetry={() => void templates.refetch()} />
        </Card>
      )}
      {templates.data && groups.length === 0 && (
        <Card>
          {canEdit ? (
            <EmptyState
              icon={<ClipboardList />}
              title="No form templates yet"
              description="Start with the built-in intake questionnaire, consents and assessments, or build your own."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button icon={<Library className="h-4 w-4" />} onClick={() => setLibraryOpen(true)}>
                    Add from library
                  </Button>
                  <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>
                    New template
                  </Button>
                </div>
              }
            />
          ) : (
            <EmptyState
              icon={<ClipboardList />}
              title="No form templates yet"
              description="Once a clinician or practice manager adds intake, consent or assessment forms, they appear here for you to share with clients."
            />
          )}
        </Card>
      )}

      <div className="space-y-6">
        {groups.map((group) => (
          <Card key={group.kind}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {FORM_KIND_LABELS[group.kind]}
                  <span className="rounded-full bg-sage-100 px-2 text-xs font-medium text-sage-700">{group.items.length}</span>
                </span>
              }
              description={KIND_DESCRIPTIONS[group.kind]}
            />
            <ul className="divide-y divide-sage-100">
              {group.items.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  canEdit={canEdit}
                  duplicating={duplicate.isPending && duplicate.variables === template.id}
                  onDuplicate={() => duplicate.mutate(template.id)}
                  onArchive={() => setArchiving(template)}
                />
              ))}
            </ul>
          </Card>
        ))}
      </div>

      {canEdit && (
        <>
          <NewTemplateModal key={newOpen ? 'open' : 'closed'} open={newOpen} onClose={() => setNewOpen(false)} />
          <LibraryModal open={libraryOpen} onClose={() => setLibraryOpen(false)} templates={list} />
        </>
      )}
      <ConfirmDialog
        open={archiving !== null}
        title="Archive this template?"
        message={
          <>
            <p>
              <strong>{archiving?.name}</strong> will no longer be available to share. Clients who were already sent it
              keep their copy, and completed forms stay in their records.
            </p>
            {archiving?.library_key && <p className="mt-2">You can add built-in forms again from the library.</p>}
          </>
        }
        confirmLabel="Archive"
        danger
        loading={archive.isPending}
        onCancel={() => setArchiving(null)}
        onConfirm={() => archiving && archive.mutate(archiving)}
      />
    </div>
  );
}
