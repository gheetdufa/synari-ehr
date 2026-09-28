import { useId } from 'react';
import { ChevronDown, FileText } from 'lucide-react';

export const GFE_NOTICE_TITLE = 'Your right to a Good Faith Estimate';

/**
 * The "right to receive a Good Faith Estimate" notice (No Surprises Act), in plain language
 * based on the CMS model notice.
 */
function NoticeText({ dark }: { dark: boolean }) {
  const link = dark ? 'text-primary-300 underline hover:text-white' : 'font-medium text-primary-700 underline';
  return (
    <div className="space-y-2">
      <p>
        If you don't have health insurance, or you choose not to use it for your care, federal law says your health care
        provider has to tell you ahead of time what your care is expected to cost. This is called a Good Faith Estimate.
      </p>
      <p>
        You can ask for a Good Faith Estimate before you schedule anything, and you'll get one automatically when you
        schedule care. For care scheduled at least 3 business days ahead, you should receive it in writing at least 1
        business day before your visit. It lists the services you can expect and what each is expected to cost.
      </p>
      <p>
        If your bill ends up being at least $400 more than your Good Faith Estimate, you have the right to dispute the
        bill. Keep a copy or a photo of your estimate so you have it if you need it.
      </p>
      <p>
        To learn more about Good Faith Estimates or the dispute process, visit{' '}
        <a className={link} href="https://www.cms.gov/nosurprises" target="_blank" rel="noreferrer">
          www.cms.gov/nosurprises
        </a>{' '}
        or call{' '}
        <a className={link} href="tel:18009853059">
          1-800-985-3059
        </a>
        .
      </p>
    </div>
  );
}

/**
 * The notice as an expandable panel (`compact`, for booking pages and footers) or always open
 * (`full`, for portal pages about billing and estimates). `dark` suits dark backgrounds.
 */
export function GoodFaithEstimateNotice({
  variant = 'compact',
  dark = false,
  className = '',
}: {
  variant?: 'compact' | 'full';
  dark?: boolean;
  className?: string;
}) {
  const headingId = useId();
  const colors = dark
    ? 'border-sage-700 bg-sage-800/60 text-sage-200'
    : 'border-sage-200 bg-white text-sage-700';
  if (variant === 'full') {
    return (
      <section aria-labelledby={headingId} className={`rounded-xl border px-4 py-4 text-sm leading-relaxed sm:px-5 ${colors} ${className}`}>
        <h2 id={headingId} className={`mb-2 flex items-center gap-2 text-base font-semibold ${dark ? 'text-white' : 'text-sage-900'}`}>
          <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-primary-600" />
          {GFE_NOTICE_TITLE}
        </h2>
        <NoticeText dark={dark} />
      </section>
    );
  }
  return (
    <details className={`group rounded-xl border text-sm leading-relaxed ${colors} ${className}`}>
      <summary
        className={`flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 [&::-webkit-details-marker]:hidden ${
          dark ? 'text-white' : 'text-sage-900'
        }`}
      >
        <span className="flex items-center gap-2">
          <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-primary-500" />
          {GFE_NOTICE_TITLE}
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4">
        <NoticeText dark={dark} />
      </div>
    </details>
  );
}
