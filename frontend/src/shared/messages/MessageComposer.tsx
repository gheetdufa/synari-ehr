import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Paperclip, SendHorizontal } from 'lucide-react';
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  type MessageAttachment,
  type SendMessageInput,
  type UploadOptions,
} from '../../api/messages';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { UploadChip, type UploadStatus } from './AttachmentChip';

/** The character counter appears once a message gets this close to the limit. */
const COUNTER_THRESHOLD = 500;
/** Tallest the textarea grows (px) before it scrolls. */
const MAX_TEXTAREA_HEIGHT = 192;

interface PendingUpload {
  key: string;
  file: File;
  status: UploadStatus;
  progress: number;
  attachment: MessageAttachment | null;
  error: string | null;
  controller: AbortController;
}

let uploadSequence = 0;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** On touch keyboards Enter inserts a new line; the Send button sends. */
function enterSendsMessage(): boolean {
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
}

export interface MessageComposerProps {
  /** Sends the message; reject to keep the draft and show the error. */
  onSend: (input: SendMessageInput) => Promise<unknown>;
  /** Uploads one attachment ahead of sending. */
  upload: (file: File, options: UploadOptions) => Promise<MessageAttachment>;
  /** Deletes an uploaded attachment the user removed before sending (best effort). */
  discard?: (attachmentId: number) => Promise<void>;
  placeholder: string;
  disabled?: boolean;
  /** Custom rendering for a send error (defaults to the server's message); null hides it. */
  renderError?: (error: unknown) => ReactNode;
  /** Shown under the input, e.g. an emergency notice. */
  footer?: ReactNode;
}

/**
 * Message input: an auto-growing textarea (Enter sends, Shift+Enter adds a line), up to five
 * attachments uploaded as soon as they're picked or dropped, and inline send errors.
 */
export function MessageComposer({ onSend, upload, discard, placeholder, disabled = false, renderError, footer }: MessageComposerProps) {
  const [body, setBody] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [enterSends] = useState(enterSendsMessage);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  const hintId = useId();

  useEffect(() => () => uploadsRef.current.forEach((item) => item.controller.abort()), []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const height = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [body]);

  const patch = (key: string, changes: Partial<PendingUpload>) =>
    setUploads((current) => current.map((item) => (item.key === key ? { ...item, ...changes } : item)));

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - uploadsRef.current.length;
    setNotice(files.length > room ? `You can attach up to ${MAX_ATTACHMENTS} files to a message.` : null);
    const created: PendingUpload[] = files.slice(0, Math.max(room, 0)).map((file) => {
      uploadSequence += 1;
      return {
        key: `upload-${uploadSequence}`,
        file,
        status: 'uploading',
        progress: 0,
        attachment: null,
        error: null,
        controller: new AbortController(),
      };
    });
    setUploads((current) => [...current, ...created]);
    for (const item of created) {
      upload(item.file, {
        signal: item.controller.signal,
        onProgress: (fraction) => patch(item.key, { progress: fraction }),
      })
        .then((attachment) => patch(item.key, { status: 'uploaded', progress: 1, attachment }))
        .catch((uploadError: unknown) => {
          if (isAbort(uploadError)) return;
          patch(item.key, {
            status: 'failed',
            error: uploadError instanceof Error ? uploadError.message : 'Upload failed',
          });
        });
    }
  };

  const removeUpload = (key: string) => {
    const item = uploadsRef.current.find((upload) => upload.key === key);
    item?.controller.abort();
    if (item?.attachment && discard) void discard(item.attachment.id).catch(() => undefined);
    setUploads((current) => current.filter((item) => item.key !== key));
    setNotice(null);
  };

  const uploading = uploads.some((item) => item.status === 'uploading');
  const failed = uploads.some((item) => item.status === 'failed');
  const attachmentIds = uploads.flatMap((item) => (item.attachment ? [item.attachment.id] : []));
  const hasContent = body.trim().length > 0 || attachmentIds.length > 0;
  const canSend = !disabled && !sending && !uploading && !failed && hasContent;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend({ body: body.trim(), attachment_ids: attachmentIds });
      setBody('');
      setUploads([]);
      setNotice(null);
      textareaRef.current?.focus();
    } catch (sendError) {
      setError(sendError);
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !enterSends) return;
    event.preventDefault();
    void submit();
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const errorContent =
    error === null
      ? null
      : renderError
        ? renderError(error)
        : <Alert tone="danger">{error instanceof Error ? error.message : 'Your message could not be sent.'}</Alert>;
  const remaining = MAX_MESSAGE_LENGTH - body.length;
  const blockedHint = failed ? 'Remove the files that failed to upload to send.' : null;

  return (
    <form
      onSubmit={onSubmit}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className="border-t border-sage-100 bg-white px-3 pb-3 pt-2.5 sm:px-4"
      aria-label="Write a message"
    >
      {errorContent && <div className="mb-2">{errorContent}</div>}
      {uploads.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attachments to send">
          {uploads.map((item) => (
            <UploadChip
              key={item.key}
              filename={item.file.name}
              sizeBytes={item.attachment?.size_bytes ?? item.file.size}
              contentType={item.attachment?.content_type ?? item.file.type}
              status={item.status}
              progress={item.progress}
              error={item.error}
              onRemove={() => removeUpload(item.key)}
            />
          ))}
        </ul>
      )}
      {notice && <p className="mb-2 text-xs text-amber-800">{notice}</p>}
      <div
        className={`flex items-end gap-1.5 rounded-2xl border bg-white px-1.5 py-1.5 transition-colors focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-200 ${
          dragging ? 'border-primary-500 bg-primary-50' : 'border-sage-200'
        } ${disabled ? 'bg-sage-50' : ''}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={onPick}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploads.length >= MAX_ATTACHMENTS}
          aria-label="Attach files"
          title={uploads.length >= MAX_ATTACHMENTS ? `Up to ${MAX_ATTACHMENTS} files per message` : 'Attach files'}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sage-600 transition-colors hover:bg-sage-100 hover:text-sage-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Paperclip className="h-5 w-5" />
        </button>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            if (error !== null) setError(null);
          }}
          onKeyDown={onKeyDown}
          readOnly={sending}
          disabled={disabled}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder={placeholder}
          aria-label="Message"
          aria-describedby={hintId}
          className="block min-h-[2.25rem] flex-1 resize-none border-0 bg-transparent px-1.5 py-2 text-sm leading-5 text-sage-900 placeholder:text-sage-400 focus:outline-none disabled:cursor-not-allowed disabled:text-sage-500"
        />
        <Button
          type="submit"
          size="sm"
          className="h-9 shrink-0 rounded-xl"
          disabled={!canSend}
          loading={sending}
          icon={sending ? undefined : <SendHorizontal className="h-4 w-4" aria-hidden="true" />}
        >
          <span className="sr-only sm:not-sr-only">Send</span>
        </Button>
      </div>
      <div id={hintId} className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-sage-500">
        <span>
          {blockedHint ?? (enterSends && !disabled ? <span className="hidden sm:inline">Enter to send · Shift + Enter for a new line</span> : null)}
        </span>
        {remaining <= COUNTER_THRESHOLD && (
          <span className={remaining === 0 ? 'font-medium text-red-700' : 'text-amber-800'}>
            {remaining === 0 ? 'Character limit reached' : `${remaining.toLocaleString('en-US')} characters left`}
          </span>
        )}
      </div>
      {footer}
    </form>
  );
}
