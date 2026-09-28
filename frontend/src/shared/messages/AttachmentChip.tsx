import { useState } from 'react';
import { AlertCircle, Download, File, FileAudio, FileImage, FileText, X } from 'lucide-react';
import { downloadFile, type Realm } from '../../api/client';
import { attachmentPath, type MessageAttachment } from '../../api/messages';
import { formatBytes } from '../../lib/format';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';

function FileIcon({ contentType, className }: { contentType: string; className: string }) {
  if (contentType.startsWith('image/')) return <FileImage className={className} aria-hidden="true" />;
  if (contentType.startsWith('audio/')) return <FileAudio className={className} aria-hidden="true" />;
  if (contentType === 'application/pdf' || contentType.startsWith('text/') || contentType.includes('word')) {
    return <FileText className={className} aria-hidden="true" />;
  }
  return <File className={className} aria-hidden="true" />;
}

/** A sent attachment inside a message bubble; downloads through the signed-in realm. */
export function AttachmentChip({
  attachment,
  realm,
  onOwnBubble,
}: {
  attachment: MessageAttachment;
  realm: Realm;
  onOwnBubble: boolean;
}) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadFile(attachmentPath(realm, attachment.id), { realm, filename: attachment.filename });
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={download}
      disabled={downloading}
      aria-label={`Download ${attachment.filename}, ${formatBytes(attachment.size_bytes)}`}
      className={`flex w-full min-w-0 max-w-xs items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:opacity-70 ${
        onOwnBubble ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-sage-50 text-sage-900 hover:bg-sage-100'
      }`}
    >
      <FileIcon contentType={attachment.content_type} className="h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{attachment.filename}</span>
        <span className={`block text-xs ${onOwnBubble ? 'text-white/80' : 'text-sage-500'}`}>
          {formatBytes(attachment.size_bytes)}
        </span>
      </span>
      {downloading ? <Spinner className="h-4 w-4 shrink-0" /> : <Download className="h-4 w-4 shrink-0" aria-hidden="true" />}
    </button>
  );
}

export type UploadStatus = 'uploading' | 'uploaded' | 'failed';

/** A file being attached in the composer: progress while uploading, error on failure, remove. */
export function UploadChip({
  filename,
  sizeBytes,
  contentType,
  status,
  progress,
  error,
  onRemove,
}: {
  filename: string;
  sizeBytes: number;
  contentType: string;
  status: UploadStatus;
  progress: number;
  error: string | null;
  onRemove: () => void;
}) {
  const percent = Math.round(progress * 100);
  return (
    <li
      className={`relative flex w-56 min-w-0 items-center gap-2 overflow-hidden rounded-xl border px-3 py-2 ${
        status === 'failed' ? 'border-red-200 bg-red-50' : 'border-sage-200 bg-sage-50'
      }`}
    >
      {status === 'failed' ? (
        <AlertCircle className="h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
      ) : (
        <FileIcon contentType={contentType} className="h-5 w-5 shrink-0 text-primary-700" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-sage-900">{filename}</span>
        <span className={`block truncate text-xs ${status === 'failed' ? 'text-red-700' : 'text-sage-500'}`}>
          {status === 'failed' && (error ?? 'Upload failed')}
          {status === 'uploading' && `Uploading… ${percent}%`}
          {status === 'uploaded' && formatBytes(sizeBytes)}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={status === 'uploading' ? `Cancel upload of ${filename}` : `Remove ${filename}`}
        className="rounded-md p-1 text-sage-500 hover:bg-sage-200 hover:text-sage-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
      >
        <X className="h-4 w-4" />
      </button>
      {status === 'uploading' && (
        <span
          role="progressbar"
          aria-label={`Uploading ${filename}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-sage-200"
        >
          <span className="block h-full bg-primary-500 transition-[width]" style={{ width: `${percent}%` }} />
        </span>
      )}
    </li>
  );
}
