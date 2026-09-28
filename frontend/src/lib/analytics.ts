/**
 * Optional Google Analytics for the public marketing pages only.
 *
 * Nothing loads unless VITE_GA_MEASUREMENT_ID is set, and events are never sent from the
 * therapist app, the client portal, video sessions or booking pages, so no analytics
 * provider ever sees screens that can contain health information.
 */

declare global {
  interface Window {
    gtag?: (command: string, ...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

const GA_MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID ?? '';

const MARKETING_PATHS = new Set([
  '/',
  '/demo',
  '/features',
  '/about',
  '/terms-of-service',
  '/privacy-policy',
  '/cookie-policy',
  '/login',
  '/register',
]);

/** Whether analytics may run on this path (public marketing pages only). */
export function isMarketingPath(pathname: string): boolean {
  return MARKETING_PATHS.has(pathname.replace(/\/$/, '') || '/');
}

function enabled(): boolean {
  return Boolean(GA_MEASUREMENT_ID) && typeof window !== 'undefined' && isMarketingPath(window.location.pathname);
}

let initialized = false;

/** Load gtag once, the first time a marketing page is shown. */
export function initGA(): void {
  if (initialized || !enabled()) return;
  initialized = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag(...args: unknown[]) {
    window.dataLayer?.push(args);
  };
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID, { send_page_view: false });
}

export function trackPageView(path: string): void {
  if (!enabled() || !window.gtag) return;
  window.gtag('event', 'page_view', { page_path: path, page_title: document.title });
}

function trackEvent(eventName: string, parameters: Record<string, unknown> = {}): void {
  if (!enabled() || !window.gtag) return;
  window.gtag('event', eventName, { event_category: 'engagement', ...parameters });
}

const marketingEvents = {
  trackCTAClick: (ctaName: string, location: string) =>
    trackEvent('cta_click', { cta_name: ctaName, cta_location: location, event_category: 'conversion' }),
  trackWaitlistJoin: (source: string) =>
    trackEvent('waitlist_join', { source, event_category: 'lead_generation' }),
  trackDemoRequest: (formData: { practice_type?: string; practice_size?: string }) =>
    trackEvent('demo_request', {
      practice_type: formData.practice_type,
      practice_size: formData.practice_size,
      event_category: 'lead_generation',
    }),
};

/** Marketing-page event helpers. */
export const useAnalytics = () => marketingEvents;
