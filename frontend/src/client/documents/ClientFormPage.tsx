import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileQuestion } from 'lucide-react';
import { ApiError } from '../../api/client';
import {
  FORM_KIND_LABELS,
  isSubmissionProblem,
  portalFormKeys,
  portalFormsApi,
  type AnswerValue,
  type FormSubmission,
  type PortalForm,
} from '../../api/forms';
import type { PortalClient } from '../../api/auth';
import { usePortalClient } from '../../auth/ClientAuth';
import { formatDate } from '../../lib/format';
import { useRealtimeEvent } from '../../lib/realtime';
import {
  answerProgress,
  buildSubmissionAnswers,
  isBlank,
  signatureProblem,
  validateAnswer,
  validateAnswers,
  type DraftAnswers,
  type FieldErrors,
} from '../../shared/forms/answers';
import { answerableFields } from '../../shared/forms/fieldTypes';
import { FormRenderer, scrollToElement, scrollToField } from '../../shared/forms/FormRenderer';
import { SignatureInput, SignatureRecord, signatureSectionId } from '../../shared/forms/Signature';
import { Button, LinkButton } from '../../ui/Button';
import { Card, CardBody } from '../../ui/Card';
import { Alert, Badge, EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { clearDraft, draftStorageKey, loadDraft, saveDraft } from './formDraftStorage';
import { pendingInOrder } from './pendingForms';

const ID_PREFIX = 'answer';
/** Forms with at least this many questions get a progress bar and a sticky submit bar. */
const LONG_FORM_QUESTIONS = 6;

function BackLink() {
  return (
    <Link
      to="/client/documents"
      className="inline-flex min-h-[44px] items-center gap-1 rounded text-sm font-medium text-sage-600 hover:text-sage-900"
    >
      <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Documents
    </Link>
  );
}

function Unavailable() {
  const { clinician_name: clinicianName } = usePortalClient();
  return (
    <div className="mx-auto max-w-2xl">
      <BackLink />
      <Card className="mt-2">
        <EmptyState
          icon={<FileQuestion />}
          title="This form isn't available"
          description={`It may have been withdrawn by ${clinicianName}. Anything you still need to complete is on your Documents page.`}
          action={<LinkButton to="/client/documents">Go to Documents</LinkButton>}
        />
      </Card>
    </div>
  );
}

function FormHeader({ form, children }: { form: PortalForm; children?: ReactNode }) {
  return (
    <header className="mb-6 mt-2">
      <p className="text-sm font-medium text-primary-700">{FORM_KIND_LABELS[form.kind]}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-sage-900">{form.name}</h1>
      {children}
    </header>
  );
}

function ProgressBar({ answered, total }: { answered: number; total: number }) {
  const percent = total ? Math.round((answered / total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label="Questions answered"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={answered}
      aria-valuetext={`${answered} of ${total} answered`}
      className="h-2 w-full overflow-hidden rounded-full bg-sage-100"
    >
      <div className="h-full rounded-full bg-primary-600 transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </div>
  );
}

function CompletedForm({ form, timeZone }: { form: PortalForm; timeZone: string }) {
  return (
    <div className="mx-auto max-w-2xl">
      <BackLink />
      <FormHeader form={form}>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-sage-600">
          <Badge tone="success">Completed</Badge>
          {form.completed_at && <span>Submitted {formatDate(form.completed_at, timeZone)}</span>}
        </p>
      </FormHeader>
      <Card>
        <CardBody className="px-5 py-6 sm:px-8">
          <FormRenderer fields={form.fields} answers={form.answers ?? {}} readOnly idPrefix={ID_PREFIX} />
        </CardBody>
      </Card>
      {form.requires_signature && (
        <div className="mt-6">
          <SignatureRecord name={form.signature_name} signedAt={form.signed_at} timeZone={timeZone} />
        </div>
      )}
    </div>
  );
}

function ThankYou({ form }: { form: PortalForm }) {
  const client = usePortalClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const forms = useQuery({ queryKey: portalFormKeys.list, queryFn: portalFormsApi.list });
  const remaining = pendingInOrder(forms.data ?? []).filter((other) => other.id !== form.id);
  const next = remaining[0];

  // Focusing the heading scrolls it into view and tells screen readers the form was sent.
  useEffect(() => heading.current?.focus(), []);

  return (
    <div className="mx-auto max-w-lg py-8 text-center">
      <CheckCircle2 aria-hidden="true" className="mx-auto h-14 w-14 text-emerald-600" />
      <h1 ref={heading} tabIndex={-1} className="mt-4 text-2xl font-semibold text-sage-900 focus:outline-none">
        Thank you
      </h1>
      <p className="mt-2 text-sage-700">
        {form.name} was submitted and sent securely to {client.clinician_name}.
      </p>
      {forms.data && (
        <p className="mt-1 text-sm text-sage-600">
          {remaining.length === 0
            ? "You're all set. There's nothing else to complete right now."
            : `You have ${remaining.length} more ${remaining.length === 1 ? 'form' : 'forms'} to complete.`}
        </p>
      )}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
        {next && (
          <LinkButton to={`/client/documents/forms/${next.id}`} className="h-12 px-6 text-base">
            Next: {next.name}
          </LinkButton>
        )}
        <LinkButton to="/client/documents" variant={next ? 'secondary' : 'primary'} className="h-12 px-6 text-base">
          Back to Documents
        </LinkButton>
      </div>
    </div>
  );
}

function FillForm({
  form,
  client,
  onSubmitted,
}: {
  form: PortalForm;
  client: PortalClient;
  onSubmitted: (form: PortalForm) => void;
}) {
  const queryClient = useQueryClient();
  const storageKey = draftStorageKey(client.id, form.id);
  const [initial] = useState(() => loadDraft(storageKey, form.fields));
  const [answers, setAnswers] = useState<DraftAnswers>(initial.answers);
  const [signatureName, setSignatureName] = useState(initial.signatureName);
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    saveDraft(storageKey, { answers, signatureName });
  }, [storageKey, answers, signatureName]);

  const questions = answerableFields(form.fields);
  const isLong = questions.length >= LONG_FORM_QUESTIONS;
  const hasRequired = questions.some((field) => field.required);
  const progress = answerProgress(form.fields, answers);
  const errorCount = Object.keys(errors).length + (signatureError ? 1 : 0);

  const revealFirstError = (fieldErrors: FieldErrors, sigError: string | null) => {
    const first = form.fields.find((field) => fieldErrors[field.id]);
    window.requestAnimationFrame(() => {
      if (first) scrollToField(ID_PREFIX, first.id);
      else if (sigError) scrollToElement(signatureSectionId(ID_PREFIX));
    });
  };

  const submit = useMutation({
    mutationFn: (submission: FormSubmission) => portalFormsApi.submit(form.id, submission),
    onSuccess: (saved) => {
      clearDraft(storageKey);
      queryClient.setQueryData(portalFormKeys.detail(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: portalFormKeys.list });
      onSubmitted(saved);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 422 && isSubmissionProblem(error.detail)) {
        const known = new Set(questions.map((field) => field.id));
        const fieldErrors = Object.fromEntries(Object.entries(error.detail.errors).filter(([id]) => known.has(id)));
        const unknown = Object.keys(error.detail.errors).length - Object.keys(fieldErrors).length;
        setErrors(fieldErrors);
        setSignatureError(error.detail.signature);
        setAttempted(true);
        setProblem(
          unknown > 0
            ? 'This form changed since you opened it. Refresh the page to load the latest version; your answers are kept.'
            : null,
        );
        revealFirstError(fieldErrors, error.detail.signature);
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        clearDraft(storageKey);
        void queryClient.invalidateQueries({ queryKey: portalFormKeys.all });
        setProblem('This form was already submitted.');
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        setProblem(`This form was withdrawn by ${client.clinician_name}, so it can no longer be submitted.`);
        return;
      }
      setProblem(
        `${error instanceof Error ? error.message : 'The form could not be submitted.'} Your answers are saved on this device, so you can try again.`,
      );
    },
  });

  const onChange = (fieldId: string, value: AnswerValue | undefined) => {
    setAnswers((current) => {
      const next = { ...current };
      if (value === undefined) delete next[fieldId];
      else next[fieldId] = value;
      return next;
    });
    const field = form.fields.find((candidate) => candidate.id === fieldId);
    if (field && (errors[fieldId] || attempted)) {
      const fieldError = validateAnswer(field, value);
      setErrors((current) => {
        const next = { ...current };
        if (fieldError) next[fieldId] = fieldError;
        else delete next[fieldId];
        return next;
      });
    }
  };

  const onBlur = (fieldId: string) => {
    const field = form.fields.find((candidate) => candidate.id === fieldId);
    if (!field || isBlank(answers[fieldId])) return;
    const fieldError = validateAnswer(field, answers[fieldId]);
    setErrors((current) => {
      const next = { ...current };
      if (fieldError) next[fieldId] = fieldError;
      else delete next[fieldId];
      return next;
    });
  };

  const updateSignature = (name: string, agree: boolean) => {
    setSignatureName(name);
    setAgreed(agree);
    if (signatureError || attempted) setSignatureError(signatureProblem(name, agree));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (submit.isPending) return;
    setProblem(null);
    setAttempted(true);
    const fieldErrors = validateAnswers(form.fields, answers);
    const sigError = form.requires_signature ? signatureProblem(signatureName, agreed) : null;
    setErrors(fieldErrors);
    setSignatureError(sigError);
    if (Object.keys(fieldErrors).length || sigError) {
      revealFirstError(fieldErrors, sigError);
      return;
    }
    submit.mutate({
      answers: buildSubmissionAnswers(form.fields, answers),
      signature_name: form.requires_signature ? signatureName.trim() : undefined,
      signature_agreed: form.requires_signature ? agreed : false,
    });
  };

  const submitLabel = form.requires_signature ? 'Sign and submit' : 'Submit';

  return (
    <div className="mx-auto max-w-2xl">
      <BackLink />
      <FormHeader form={form}>
        {(hasRequired || form.requires_signature) && (
          <p className="mt-2 text-sm text-sage-600">
            {hasRequired && (
              <>
                Questions marked <span className="text-red-600">*</span> are required.{' '}
              </>
            )}
            {form.requires_signature && 'You’ll sign at the end.'}
          </p>
        )}
        {isLong && (
          <div className="mt-4 space-y-1.5">
            <ProgressBar answered={progress.answered} total={progress.total} />
            <p className="text-xs text-sage-500">
              {progress.answered} of {progress.total} answered
            </p>
          </div>
        )}
      </FormHeader>

      <form noValidate onSubmit={onSubmit} aria-label={form.name}>
        <div className="space-y-6">
          {problem && (
            <Alert tone="danger" title="Your form wasn't submitted">
              {problem}
            </Alert>
          )}
          {attempted && errorCount > 0 && (
            <Alert tone="danger">
              {errorCount === 1 ? '1 answer needs' : `${errorCount} answers need`} attention. {errorCount === 1 ? "It's" : "They're"}{' '}
              highlighted below.
            </Alert>
          )}
          <Card>
            <CardBody className="px-5 py-6 sm:px-8">
              <FormRenderer
                fields={form.fields}
                answers={answers}
                onChange={onChange}
                onBlur={onBlur}
                errors={errors}
                idPrefix={ID_PREFIX}
              />
            </CardBody>
          </Card>
          {form.requires_signature && (
            <SignatureInput
              idPrefix={ID_PREFIX}
              name={signatureName}
              agreed={agreed}
              onNameChange={(name) => updateSignature(name, agreed)}
              onAgreedChange={(agree) => updateSignature(signatureName, agree)}
              error={signatureError}
            />
          )}
          <p className="text-xs text-sage-500">
            Your answers are kept in this browser tab until you submit, so you won't lose them if the page reloads.
          </p>
        </div>

        {isLong ? (
          <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-sage-200 bg-white/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:shadow-lg">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-sage-800">
                  {progress.answered} of {progress.total} answered
                </p>
                <p className="text-xs text-sage-500">
                  {progress.requiredLeft > 0 ? `${progress.requiredLeft} required left` : 'All required questions answered'}
                </p>
              </div>
              <Button type="submit" loading={submit.isPending} className="h-12 shrink-0 px-6 text-base">
                {submitLabel}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-6 flex justify-end">
            <Button type="submit" loading={submit.isPending} className="h-12 w-full px-6 text-base sm:w-auto">
              {submitLabel}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}

function ClientForm({ formId }: { formId: number }) {
  const client = usePortalClient();
  const queryClient = useQueryClient();
  const [submitted, setSubmitted] = useState<PortalForm | null>(null);
  const query = useQuery({
    queryKey: portalFormKeys.detail(formId),
    queryFn: () => portalFormsApi.get(formId),
    // Each fetch is audited and the answers live in local state, so don't refetch on focus.
    refetchOnWindowFocus: false,
  });

  useRealtimeEvent('client_form.revoked', (event) => {
    if (event.data.client_form_id !== formId) return;
    clearDraft(draftStorageKey(client.id, formId));
    void queryClient.invalidateQueries({ queryKey: portalFormKeys.all });
  });

  if (submitted) return <ThankYou form={submitted} />;
  if (query.isPending) return <SectionSpinner />;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 404) return <Unavailable />;
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink />
        <Card className="mt-2">
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      </div>
    );
  }
  const form = query.data;
  if (form.status === 'completed') return <CompletedForm form={form} timeZone={client.time_zone} />;
  return <FillForm form={form} client={client} onSubmitted={setSubmitted} />;
}

/** /client/documents/forms/:formId — complete (or review) one form. */
export default function ClientFormPage() {
  const { formId } = useParams();
  const id = Number(formId);
  if (!Number.isInteger(id) || id <= 0) return <Unavailable />;
  return <ClientForm key={id} formId={id} />;
}
