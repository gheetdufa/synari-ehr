import { AlertCircle, PenLine } from 'lucide-react';
import { formatDate, formatTime } from '../../lib/format';
import { Input } from '../../ui/Form';
import { INVALID_CONTROL, SIGNATURE_MAX_LENGTH } from './fieldTypes';

/** DOM id of the signature section, used to scroll to it when it has an error. */
export function signatureSectionId(idPrefix: string): string {
  return `${idPrefix}-signature`;
}

export const E_SIGNATURE_CONSENT =
  'By typing my name and checking the box below, I agree that my electronic signature is the legal ' +
  'equivalent of my handwritten signature on this document, and that I have read and agree to its ' +
  'contents. My typed name, the date and time, and my device’s IP address are recorded with my signature.';

/** "Type your full name" plus the agreement checkbox a client completes to sign a form. */
export function SignatureInput({
  idPrefix,
  name,
  agreed,
  onNameChange,
  onAgreedChange,
  onBlur,
  error,
}: {
  idPrefix: string;
  name: string;
  agreed: boolean;
  onNameChange: (name: string) => void;
  onAgreedChange: (agreed: boolean) => void;
  onBlur?: () => void;
  error?: string | null;
}) {
  const base = signatureSectionId(idPrefix);
  const errorId = error ? `${base}-error` : undefined;
  const consentId = `${base}-consent`;
  const describedBy = [consentId, errorId].filter(Boolean).join(' ');
  return (
    <section id={base} aria-labelledby={`${base}-title`} className="rounded-2xl border border-primary-200 bg-primary-50/60 p-4 sm:p-6">
      <h2 id={`${base}-title`} className="flex items-center gap-2 text-lg font-semibold text-sage-900">
        <PenLine aria-hidden="true" className="h-5 w-5 text-primary-700" />
        Sign this form
      </h2>
      <p id={consentId} className="mt-2 text-sm leading-relaxed text-sage-700">
        {E_SIGNATURE_CONSENT}
      </p>
      <div className="mt-4">
        <label htmlFor={`${base}-name`} className="block text-base font-medium text-sage-900">
          Type your full name
          <span aria-hidden="true" className="ml-1 text-red-600">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </label>
        <Input
          id={`${base}-name`}
          value={name}
          maxLength={SIGNATURE_MAX_LENGTH}
          autoComplete="name"
          autoCapitalize="words"
          spellCheck={false}
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={onBlur}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          aria-required
          className={`mt-2 h-12 text-base ${INVALID_CONTROL}`}
        />
        {name.trim() && (
          <p aria-hidden="true" className="mt-3 truncate border-b border-sage-300 pb-1 font-serif text-2xl italic text-sage-900">
            {name.trim()}
          </p>
        )}
      </div>
      <label
        htmlFor={`${base}-agree`}
        className={`mt-4 flex min-h-[48px] cursor-pointer items-start gap-3 rounded-xl border bg-white px-4 py-3 text-base focus-within:ring-2 focus-within:ring-primary-300 ${
          agreed ? 'border-primary-500' : error ? 'border-red-300' : 'border-sage-200'
        }`}
      >
        <input
          id={`${base}-agree`}
          type="checkbox"
          checked={agreed}
          onChange={(event) => onAgreedChange(event.target.checked)}
          aria-describedby={describedBy}
          aria-required
          className="mt-0.5 h-5 w-5 shrink-0 accent-primary-600"
        />
        <span className="font-medium text-sage-900">I agree to sign this form electronically</span>
      </label>
      {error && (
        <p id={errorId} className="mt-2 flex items-start gap-1.5 text-sm font-medium text-red-700">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
    </section>
  );
}

/** The recorded e-signature on a completed form. IP and device are shown to staff only. */
export function SignatureRecord({
  name,
  signedAt,
  timeZone,
  ipAddress,
  userAgent,
}: {
  name: string;
  signedAt: string | null;
  timeZone?: string;
  ipAddress?: string;
  userAgent?: string;
}) {
  return (
    <section aria-label="Electronic signature" className="rounded-xl border border-sage-200 bg-sage-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-sage-500">Electronically signed</p>
      <p className="mt-2 truncate border-b border-sage-300 pb-1 font-serif text-2xl italic text-sage-900">{name || '—'}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-sage-500">Signed by</dt>
        <dd className="text-sage-900">{name || '—'}</dd>
        {signedAt && (
          <>
            <dt className="text-sage-500">Date and time</dt>
            <dd className="text-sage-900">
              {formatDate(signedAt, timeZone)} at {formatTime(signedAt, timeZone)}
            </dd>
          </>
        )}
        {ipAddress && (
          <>
            <dt className="text-sage-500">IP address</dt>
            <dd className="font-mono text-sage-900">{ipAddress}</dd>
          </>
        )}
        {userAgent && (
          <>
            <dt className="text-sage-500">Device</dt>
            <dd className="break-words text-xs text-sage-700">{userAgent}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
