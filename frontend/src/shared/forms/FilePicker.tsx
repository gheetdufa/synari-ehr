import { useId, useRef, useState, type DragEvent } from 'react';
import { AlertCircle, FileText, Upload, X } from 'lucide-react';
import { DOCUMENT_ACCEPT } from '../../api/files';
import { formatBytes } from '../../lib/format';

/** Tap-or-drop file chooser for document uploads, with the chosen file and any error. */
export function FilePicker({
  file,
  onChange,
  error,
  label = 'Choose a file',
  hint = 'PDF, image (JPG, PNG, HEIC), Word document or text file, up to 50 MB',
  disabled = false,
}: {
  file: File | null;
  onChange: (file: File | null) => void;
  error?: string | null;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = event.dataTransfer.files[0];
    if (dropped) onChange(dropped);
  };

  const clear = () => {
    onChange(null);
    if (input.current) input.current.value = '';
  };

  return (
    <div>
      {file ? (
        <div className="flex items-center gap-3 rounded-xl border border-sage-200 bg-white px-4 py-3">
          <FileText aria-hidden="true" className="h-6 w-6 shrink-0 text-primary-700" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-sage-900">{file.name}</p>
            <p className="text-xs text-sage-500">{formatBytes(file.size)}</p>
          </div>
          <button
            type="button"
            onClick={clear}
            disabled={disabled}
            aria-label={`Remove ${file.name}`}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-sage-500 hover:bg-sage-100 hover:text-sage-800 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <label
          htmlFor={id}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors focus-within:ring-2 focus-within:ring-primary-300 ${
            dragging ? 'border-primary-500 bg-primary-50' : error ? 'border-red-300 bg-white' : 'border-sage-200 bg-white hover:bg-sage-50'
          }`}
        >
          <Upload aria-hidden="true" className="h-6 w-6 text-primary-700" />
          <span className="text-sm font-medium text-primary-800">{label}</span>
          <span id={`${id}-hint`} className="text-xs text-sage-500">
            {hint}
          </span>
        </label>
      )}
      <input
        ref={input}
        id={id}
        type="file"
        accept={DOCUMENT_ACCEPT}
        disabled={disabled}
        className="sr-only"
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 flex items-start gap-1.5 text-sm font-medium text-red-700">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
