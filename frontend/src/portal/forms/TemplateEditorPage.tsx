import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, FileQuestion, Lock } from 'lucide-react';
import { ApiError } from '../../api/client';
import {
  FORM_KINDS,
  FORM_KIND_LABELS,
  formKeys,
  formsApi,
  type FormKind,
  type FormTemplate,
} from '../../api/forms';
import type { DraftAnswers } from '../../shared/forms/answers';
import { MAX_DESCRIPTION_LENGTH, MAX_TEMPLATE_NAME_LENGTH } from '../../shared/forms/fieldTypes';
import { FormRenderer } from '../../shared/forms/FormRenderer';
import { SignatureInput } from '../../shared/forms/Signature';
import { Button, LinkButton } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, Badge, EmptyState, ErrorState, PageHeader, Tabs } from '../../ui/Display';
import { Field, Input, Select, Switch, Textarea } from '../../ui/Form';
import { ConfirmDialog } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import type { FieldsUpdater } from './FieldEditorCard';
import { FieldListEditor } from './FieldListEditor';
import { ScoringSummary } from './ScoringSummary';
import {
  countErrors,
  fromDraft,
  sameContent,
  scoringFieldIds,
  toDraft,
  toFormField,
  validateDraft,
  type TemplateDraft,
} from './templateDraft';
import { useCanEditTemplates, useDuplicateTemplate } from './useTemplateActions';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

function BackLink() {
  return (
    <Link to="/portal/forms" className="inline-flex items-center gap-1 rounded text-sm font-medium text-sage-600 hover:text-sage-900">
      <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Forms
    </Link>
  );
}

function NotFound() {
  return (
    <Card>
      <EmptyState
        icon={<FileQuestion />}
        title="Form template not found"
        description="It may have been archived. Forms already sent to clients aren't affected."
        action={<LinkButton to="/portal/forms">Back to forms</LinkButton>}
      />
    </Card>
  );
}

/** Try-it-out preview using the same renderer clients see. */
function PreviewPane({ draft, headingLevel }: { draft: TemplateDraft; headingLevel: 2 | 3 }) {
  const [answers, setAnswers] = useState<DraftAnswers>({});
  const [signatureName, setSignatureName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const fields = useMemo(() => draft.fields.map(toFormField), [draft.fields]);
  const reset = () => {
    setAnswers({});
    setSignatureName('');
    setAgreed(false);
  };
  return (
    <Card>
      <CardHeader
        title="Client preview"
        description="What clients see. Try answering; nothing is saved."
        actions={
          <Button size="sm" variant="ghost" onClick={reset}>
            Reset
          </Button>
        }
      />
      <CardBody className="space-y-6">
        <p className="text-xl font-semibold text-sage-900">{draft.name.trim() || 'Untitled form'}</p>
        {fields.length ? (
          <FormRenderer
            fields={fields}
            answers={answers}
            onChange={(fieldId, value) => setAnswers((current) => ({ ...current, [fieldId]: value }))}
            idPrefix="preview"
            headingLevel={headingLevel}
          />
        ) : (
          <p className="text-sm text-sage-500">Add fields to see them here.</p>
        )}
        {draft.requires_signature && (
          <SignatureInput
            idPrefix="preview"
            name={signatureName}
            agreed={agreed}
            onNameChange={setSignatureName}
            onAgreedChange={setAgreed}
          />
        )}
      </CardBody>
    </Card>
  );
}

/**
 * A template shown without editing: built-in scored assessments are locked for everyone (editors
 * can make a copy), and staff who don't maintain templates see every template this way.
 */
function ReadOnlyTemplate({ template, canEdit }: { template: FormTemplate; canEdit: boolean }) {
  const duplicate = useDuplicateTemplate();
  const draft = useMemo(() => toDraft(template), [template]);
  const locked = template.read_only;
  return (
    <div>
      <div className="mb-4">
        <BackLink />
      </div>
      <PageHeader
        title={template.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="primary">{FORM_KIND_LABELS[template.kind]}</Badge>
            {template.library_key && <Badge>Built-in</Badge>}
            <Badge tone="warning">
              <Lock aria-hidden="true" className="h-3 w-3" /> Read-only
            </Badge>
          </span>
        }
        actions={
          canEdit && (
            <Button
              variant="secondary"
              icon={<Copy className="h-4 w-4" />}
              loading={duplicate.isPending}
              onClick={() => duplicate.mutate(template.id)}
            >
              Make an editable copy
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <div className="space-y-6">
          {locked ? (
            <Alert tone="info" title="This assessment can't be edited">
              Built-in scored assessments are locked so their automatic scoring stays valid. You can share it with
              clients as it is.{canEdit && " An editable copy won't be scored or flagged automatically."}
            </Alert>
          ) : (
            <Alert tone="info" title="View only">
              Clinicians and practice managers maintain form templates. You can share this form with clients as it is.
            </Alert>
          )}
          {template.description && (
            <Card>
              <CardHeader title={template.kind === 'assessment' ? 'About this assessment' : 'About this form'} />
              <CardBody>
                <p className="whitespace-pre-line text-sm text-sage-700">{template.description}</p>
              </CardBody>
            </Card>
          )}
          {template.scoring && (
            <Card>
              <CardHeader title="Scoring" />
              <CardBody>
                <ScoringSummary scoring={template.scoring} fields={template.fields} />
              </CardBody>
            </Card>
          )}
        </div>
        <PreviewPane draft={draft} headingLevel={3} />
      </div>
    </div>
  );
}

function TemplateEditor({ template }: { template: FormTemplate }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [baseline, setBaseline] = useState<TemplateDraft>(() => toDraft(template));
  const [draft, setDraft] = useState<TemplateDraft>(baseline);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showErrors, setShowErrors] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [view, setView] = useState<'build' | 'preview'>('build');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const reveal = useRef<string | null>(null);

  const dirty = useMemo(() => !sameContent(draft, baseline), [draft, baseline]);
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const errorCount = countErrors(errors);
  const lockedIds = useMemo(() => scoringFieldIds(template.scoring), [template.scoring]);
  const missingFlagFields = [...lockedIds].filter((id) => !draft.fields.some((field) => field.id === id));
  const guard = useUnsavedChangesGuard(dirty);

  const update: FieldsUpdater = useCallback((change) => setDraft((current) => ({ ...current, fields: change(current.fields) })), []);
  const setDetails = (changes: Partial<Omit<TemplateDraft, 'fields'>>) => setDraft((current) => ({ ...current, ...changes }));

  useEffect(() => {
    const target = reveal.current;
    if (!target) return;
    reveal.current = null;
    const element = document.querySelector<HTMLElement>(`[data-field-uid="${target}"], [data-setting="${target}"]`);
    element?.scrollIntoView?.({ block: 'center' });
    element?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
  });

  const save = useMutation({
    mutationFn: (submitted: TemplateDraft) => formsApi.updateTemplate(template.id, fromDraft(submitted)),
    onSuccess: (saved, submitted) => {
      queryClient.setQueryData(formKeys.template(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: formKeys.templates });
      setBaseline(submitted);
      // Saved ids are fixed from now on so they don't change with later label edits.
      setDraft((current) => ({ ...current, fields: current.fields.map((field) => (field.autoId ? { ...field, autoId: false } : field)) }));
      setServerError(null);
      toast.success('Form saved');
    },
    onError: (error) => {
      setServerError(error instanceof Error ? error.message : 'The form could not be saved.');
      toast.error(error);
    },
  });

  const onSave = () => {
    setServerError(null);
    if (errorCount > 0) {
      setShowErrors(true);
      setView('build');
      const firstField = draft.fields.find((field) => errors.fields[field.uid]);
      if (errors.name) reveal.current = 'name';
      else if (firstField) {
        setExpanded((current) => new Set(current).add(firstField.uid));
        reveal.current = firstField.uid;
      }
      toast.error(`Fix ${errorCount} ${errorCount === 1 ? 'problem' : 'problems'} before saving.`);
      return;
    }
    save.mutate(draft);
  };

  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const shownIssues = showErrors ? errors.fields : {};
  const kindLockedForLibrary = template.library_key !== null && template.kind !== 'assessment';

  return (
    <div>
      {guard}
      <div className="sticky top-16 z-10 -mx-4 -mt-6 mb-6 border-b border-sage-100 bg-sage-50/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mt-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <BackLink />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-sage-900 sm:text-xl">{draft.name.trim() || 'Untitled form'}</h1>
            <p className="text-xs text-sage-500" aria-live="polite">
              {save.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {showErrors && errorCount > 0 && <Badge tone="danger">{errorCount} to fix</Badge>}
            <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => setConfirmDiscard(true)}>
              Discard
            </Button>
            <Button onClick={onSave} loading={save.isPending} disabled={!dirty} aria-keyshortcuts="Control+S Meta+S">
              Save
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-4 lg:hidden">
        <Tabs
          tabs={[
            { id: 'build', label: 'Edit' },
            { id: 'preview', label: 'Preview' },
          ]}
          active={view}
          onChange={setView}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <div className={`${view === 'build' ? 'block' : 'hidden'} space-y-6 lg:block`}>
          {serverError && (
            <Alert tone="danger" title="The form wasn't saved">
              {serverError}
            </Alert>
          )}
          {template.scoring && template.scoring.flags.length > 0 && (
            <Alert tone={missingFlagFields.length ? 'warning' : 'info'} title="Automatic flagging">
              <ScoringSummary scoring={template.scoring} fields={template.fields} />
              {missingFlagFields.length > 0 && (
                <p className="mt-2 font-medium">
                  A question used for flagging has been removed, so responses to it won't be flagged once you save.
                </p>
              )}
            </Alert>
          )}

          <Card>
            <CardHeader title="Details" />
            <CardBody className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <div data-setting="name">
                  <Field label="Name" required error={showErrors ? errors.name : undefined}>
                    {(props) => (
                      <Input
                        {...props}
                        value={draft.name}
                        maxLength={MAX_TEMPLATE_NAME_LENGTH}
                        onChange={(event) => setDetails({ name: event.target.value })}
                      />
                    )}
                  </Field>
                </div>
                <Field label="Kind">
                  {(props) => (
                    <Select {...props} value={draft.kind} onChange={(event) => setDetails({ kind: event.target.value as FormKind })}>
                      {FORM_KINDS.map((kind) => (
                        <option key={kind} value={kind} disabled={kind === 'assessment' && kindLockedForLibrary}>
                          {FORM_KIND_LABELS[kind]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <Field
                label="Description"
                hint="Only you see this. It isn't shown to clients."
                error={showErrors ? errors.description : undefined}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    rows={3}
                    maxLength={MAX_DESCRIPTION_LENGTH}
                    value={draft.description}
                    onChange={(event) => setDetails({ description: event.target.value })}
                  />
                )}
              </Field>
              <Switch
                checked={draft.requires_signature}
                onChange={(checked) => setDetails({ requires_signature: checked })}
                label="Require an e-signature"
                description="Clients type their full name and agree to sign electronically. Their name, the time and their IP address are recorded."
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Fields"
              description={`${draft.fields.length} ${draft.fields.length === 1 ? 'field' : 'fields'}`}
              actions={
                draft.fields.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setExpanded(expanded.size ? new Set() : new Set(draft.fields.map((field) => field.uid)))
                    }
                  >
                    {expanded.size ? 'Collapse all' : 'Expand all'}
                  </Button>
                )
              }
            />
            <CardBody>
              {showErrors && errors.form.length > 0 && (
                <div className="mb-3">
                  <Alert tone="danger">{errors.form.join(' ')}</Alert>
                </div>
              )}
              <FieldListEditor
                fields={draft.fields}
                update={update}
                issues={shownIssues}
                expanded={expanded}
                setExpanded={setExpanded}
                lockedIds={lockedIds}
              />
            </CardBody>
          </Card>
        </div>

        <aside aria-label="Client preview" className={`${view === 'preview' ? 'block' : 'hidden'} lg:block`}>
          <div className="lg:sticky lg:top-36 lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto lg:rounded-xl">
            <PreviewPane draft={draft} headingLevel={3} />
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard your changes?"
        message="The form goes back to how it was when you last saved it."
        confirmLabel="Discard changes"
        danger
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setDraft(baseline);
          setShowErrors(false);
          setServerError(null);
          setConfirmDiscard(false);
        }}
      />
    </div>
  );
}

function TemplateLoader({ templateId }: { templateId: number }) {
  const canEdit = useCanEditTemplates();
  const query = useQuery({ queryKey: formKeys.template(templateId), queryFn: () => formsApi.template(templateId) });
  if (query.isPending) return <SectionSpinner />;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 404) return <NotFound />;
    return (
      <div>
        <div className="mb-4">
          <BackLink />
        </div>
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      </div>
    );
  }
  const template = query.data;
  if (template.read_only || !canEdit) return <ReadOnlyTemplate template={template} canEdit={canEdit} />;
  return <TemplateEditor key={template.id} template={template} />;
}

/** /portal/forms/templates/:templateId — build and preview a form template. */
export default function TemplateEditorPage() {
  const { templateId } = useParams();
  const id = Number(templateId);
  if (!Number.isInteger(id) || id <= 0) return <NotFound />;
  return <TemplateLoader templateId={id} />;
}
