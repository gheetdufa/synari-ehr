import { useRef, useState, type DragEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, FileArchive, FileSpreadsheet, KeyRound, Search, Trash2, Upload } from 'lucide-react';
import {
  DEFAULT_IMPORT_MAX_BYTES,
  IMPORT_EXTENSIONS,
  importsApi,
  type ImportFile,
  type ImportFileKind,
  type ImportJob,
  type ImportJobUpdate,
  type ImportKindInfo,
} from '../../../api/imports';
import { formatBytes } from '../../../lib/format';
import { usePublicConfig } from '../../../lib/usePublicConfig';
import { Button, IconButton } from '../../../ui/Button';
import { Card, CardBody, CardHeader } from '../../../ui/Card';
import { Alert, Badge } from '../../../ui/Display';
import { Field, Input, Select } from '../../../ui/Form';
import { useToast } from '../../../ui/Toast';
import {
  acceptsSplitName,
  analyzeBlockers,
  importFileProblem,
  isSpreadsheet,
  kindLabel,
  unmatchedRequired,
  withMappedColumn,
} from './importLogic';
import { ProgressBar } from './ProgressBar';
import { useStoreImportJob } from './useImportJob';

interface PendingUpload {
  key: number;
  name: string;
  fraction: number;
  error: string | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The upload failed. Please try again.';
}

/** Password for a password-protected Complete export zip (stored encrypted, never shown). */
function ZipPassword({ job, onSave, saving }: { job: ImportJob; onSave: (password: string) => void; saving: boolean }) {
  const [editing, setEditing] = useState(!job.options.zip_password_set);
  const [password, setPassword] = useState('');
  if (job.options.zip_password_set && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="success">
          <KeyRound aria-hidden="true" className="h-3 w-3" />
          Password saved
        </Badge>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Change password
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!password) return;
        onSave(password);
        setPassword('');
        setEditing(false);
      }}
    >
      <Field
        label="Zip password"
        hint="The password SimplePractice showed with the export. It's stored encrypted and deleted when the import finishes."
        className="min-w-[14rem] flex-1"
      >
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <Button type="submit" size="sm" loading={saving} disabled={!password}>
        Save password
      </Button>
    </form>
  );
}

/** Which of the file's columns each field is read from. */
function ColumnMapping({
  file,
  info,
  columns,
  disabled,
  onChange,
}: {
  file: ImportFile;
  info: ImportKindInfo;
  columns: Record<string, string | null>;
  disabled: boolean;
  onChange: (field: string, header: string | null) => void;
}) {
  const missing = unmatchedRequired(info, columns);
  const [expanded, setExpanded] = useState(missing.length > 0);
  const panelId = `columns-${file.file_id}`;
  return (
    <div className="rounded-lg border border-sage-100">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left text-sm font-medium text-sage-800 hover:bg-sage-50"
      >
        <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        Columns in {file.filename}
        {missing.length > 0 ? (
          <Badge tone="warning">{missing.length} required not matched</Badge>
        ) : (
          <Badge tone="success">Required columns matched</Badge>
        )}
      </button>
      {expanded && (
        <div id={panelId} className="grid gap-3 border-t border-sage-100 px-4 py-4 sm:grid-cols-2">
          {info.fields.map((field) => {
            const current = columns[field.name] ?? '';
            const headers = current && !file.headers.includes(current) ? [current, ...file.headers] : file.headers;
            return (
              <Field
                key={field.name}
                label={field.label}
                required={field.required}
                hint={field.required && acceptsSplitName(info, field.name) ? 'Or match First name and Last name.' : undefined}
              >
                {(props) => (
                  <Select
                    {...props}
                    value={current}
                    disabled={disabled}
                    onChange={(event) => onChange(field.name, event.target.value || null)}
                  >
                    <option value="">Not imported</option>
                    {headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Upload the SimplePractice files, correct what each one is, set the zip password and check the
 * column mapping; then analyze. `compact` hides the analyze button (used on the review step,
 * where any change sends the import back here).
 */
export function UploadStep({
  job,
  kinds,
  compact = false,
}: {
  job: ImportJob;
  kinds: ImportKindInfo[] | undefined;
  compact?: boolean;
}) {
  const store = useStoreImportJob();
  const toast = useToast();
  const config = usePublicConfig();
  const maxBytes = config.import_max_bytes ?? DEFAULT_IMPORT_MAX_BYTES;
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  const update = useMutation({
    mutationFn: (changes: ImportJobUpdate) => importsApi.update(job.id, changes),
    onSuccess: store,
    onError: (error) => toast.error(error),
  });
  const remove = useMutation({
    mutationFn: (fileId: number) => importsApi.removeFile(job.id, fileId),
    onSuccess: store,
    onError: (error) => toast.error(error),
  });
  const analyze = useMutation({
    mutationFn: () => importsApi.analyze(job.id),
    onSuccess: store,
    onError: (error) => toast.error(error),
  });

  const setProgress = (key: number, change: Partial<PendingUpload>) =>
    setUploads((current) => current.map((upload) => (upload.key === key ? { ...upload, ...change } : upload)));

  // One file at a time: exports can be large, and each upload updates the same import.
  const uploadFiles = async (files: File[]) => {
    const entries = files.map((file) => ({ file, key: nextKey.current++, problem: importFileProblem(file, maxBytes) }));
    setUploads((current) => [
      ...current,
      ...entries.map(({ file, key, problem }) => ({ key, name: file.name, fraction: 0, error: problem })),
    ]);
    setUploading(true);
    try {
      for (const entry of entries) {
        if (entry.problem) continue;
        try {
          const updated = await importsApi.upload(job.id, entry.file, {
            onProgress: (fraction) => setProgress(entry.key, { fraction }),
          });
          store(updated);
          setUploads((current) => current.filter((upload) => upload.key !== entry.key));
        } catch (error) {
          setProgress(entry.key, { error: errorText(error) });
        }
      }
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void uploadFiles(Array.from(event.dataTransfer.files));
  };

  const busy = uploading || update.isPending || remove.isPending || analyze.isPending;
  const blockers = analyzeBlockers(job, kinds);
  const spreadsheets = job.files.filter(isSpreadsheet);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Upload your SimplePractice files"
          description="Add the Complete export zip and any reports you downloaded. We work out what each file is from its columns; correct it if we got it wrong."
        />
        <CardBody className="space-y-4">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
              dragging ? 'border-primary-400 bg-primary-50' : 'border-sage-200 bg-sage-50/50'
            }`}
          >
            <Upload aria-hidden="true" className="h-8 w-8 text-sage-400" />
            <p className="text-sm text-sage-700">Drag files here, or</p>
            <Button variant="secondary" size="sm" disabled={uploading} onClick={() => input.current?.click()}>
              Choose files
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              accept={IMPORT_EXTENSIONS.join(',')}
              className="sr-only"
              aria-label="Choose SimplePractice files"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void uploadFiles(files);
              }}
            />
            <p className="text-xs text-sage-500">
              The Complete export (.zip) and reports as .csv or .xlsx, up to {formatBytes(maxBytes)} each.
            </p>
          </div>

          {uploads.length > 0 && (
            <ul className="space-y-3" aria-label="Uploads">
              {uploads.map((upload) => (
                <li key={upload.key} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium text-sage-800">{upload.name}</span>
                    {upload.error ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setUploads((current) => current.filter((item) => item.key !== upload.key))}
                      >
                        Dismiss
                      </Button>
                    ) : (
                      <span className="text-sage-500">{Math.round(upload.fraction * 100)}%</span>
                    )}
                  </div>
                  {upload.error ? (
                    <p className="text-sm text-red-600">{upload.error}</p>
                  ) : (
                    <ProgressBar label={`Uploading ${upload.name}`} percent={upload.fraction * 100} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>

        {job.files.length > 0 && (
          <ul className="divide-y divide-sage-100 border-t border-sage-100" aria-label="Uploaded files">
            {job.files.map((file) => {
              const Icon = file.kind === 'export_zip' ? FileArchive : FileSpreadsheet;
              const detected = file.kind !== null && file.kind === file.detected_kind;
              return (
                <li key={file.file_id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary-700" />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-sage-900">{file.filename}</p>
                        <p className="text-sm text-sage-600">
                          {formatBytes(file.size_bytes)}
                          {detected && (
                            <>
                              {' · '}
                              <Search aria-hidden="true" className="inline h-3 w-3" /> Recognized automatically
                            </>
                          )}
                          {file.encrypted && ' · Password protected'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pl-8 sm:pl-0">
                      <Select
                        aria-label={`What ${file.filename} is`}
                        className="sm:w-64"
                        value={file.kind ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          event.target.value &&
                          update.mutate({ files: [{ file_id: file.file_id, kind: event.target.value as ImportFileKind }] })
                        }
                      >
                        {file.kind === null && <option value="">Choose what this file is…</option>}
                        {(kinds ?? []).map((info) => (
                          <option key={info.kind} value={info.kind}>
                            {info.label}
                          </option>
                        ))}
                        {kinds === undefined && file.kind && <option value={file.kind}>{kindLabel(file.kind, kinds)}</option>}
                      </Select>
                      <IconButton
                        label={`Remove ${file.filename}`}
                        disabled={busy}
                        onClick={() => remove.mutate(file.file_id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </div>
                  {file.kind === 'export_zip' && file.encrypted && (
                    <div className="pl-8">
                      <ZipPassword
                        job={job}
                        saving={update.isPending}
                        onSave={(password) => update.mutate({ zip_password: password })}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {spreadsheets.length > 0 && (
        <Card>
          <CardHeader
            title="Check the columns"
            description="Each Synari field is read from the column shown. Change any that are wrong, or choose Not imported to leave a field out."
          />
          <CardBody className="space-y-3">
            {spreadsheets.map((file) => {
              const info = kinds?.find((candidate) => candidate.kind === file.kind);
              if (!info) return null;
              return (
                <ColumnMapping
                  key={`${file.file_id}-${file.kind}`}
                  file={file}
                  info={info}
                  columns={job.mapping[String(file.file_id)] ?? {}}
                  disabled={busy}
                  onChange={(field, header) =>
                    update.mutate({ mapping: withMappedColumn(job.mapping, file.file_id, field, header) })
                  }
                />
              );
            })}
          </CardBody>
        </Card>
      )}

      {!compact && (
        <Card>
          <CardBody className="space-y-3">
            {blockers.length > 0 && job.files.length > 0 && (
              <Alert tone="warning" title="Before analyzing">
                <ul className="list-disc space-y-1 pl-5">
                  {blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-sage-600">
                Analyzing reads your files and shows what will be imported. Nothing is imported yet.
              </p>
              <Button disabled={blockers.length > 0 || busy} loading={analyze.isPending} onClick={() => analyze.mutate()}>
                Analyze files
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
