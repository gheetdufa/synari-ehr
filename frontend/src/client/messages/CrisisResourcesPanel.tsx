import { HeartHandshake, MessageCircle, Phone, X } from 'lucide-react';

const actionClasses =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2';

/**
 * Shown right after a client sends a message with crisis language: how to get help now, since
 * their clinician may not read the message for a while.
 */
export function CrisisResourcesPanel({ clinicianName, onClose }: { clinicianName: string; onClose: () => void }) {
  return (
    <section
      role="alert"
      aria-labelledby="crisis-resources-heading"
      className="relative border-t border-primary-200 bg-primary-50 px-4 py-4 sm:px-5"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close crisis resources"
        className="absolute right-2 top-2 rounded-lg p-1.5 text-primary-800 hover:bg-primary-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex gap-3 pr-8">
        <HeartHandshake className="mt-0.5 h-6 w-6 shrink-0 text-primary-700" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="crisis-resources-heading" className="text-base font-semibold text-primary-900">
            You don’t have to wait for a reply to get support
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-primary-900">
            If you are in danger or thinking about harming yourself, call or text 988 (Suicide &amp; Crisis Lifeline)
            or call 911. {clinicianName} may not see messages right away.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="tel:988" className={`${actionClasses} bg-primary-700 text-white hover:bg-primary-800`}>
              <Phone className="h-4 w-4" aria-hidden="true" /> Call 988
            </a>
            <a href="sms:988" className={`${actionClasses} border border-primary-300 bg-white text-primary-800 hover:bg-primary-100`}>
              <MessageCircle className="h-4 w-4" aria-hidden="true" /> Text 988
            </a>
            <a href="tel:911" className={`${actionClasses} border border-primary-300 bg-white text-primary-800 hover:bg-primary-100`}>
              <Phone className="h-4 w-4" aria-hidden="true" /> Call 911
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
