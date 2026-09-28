import { TZDate } from '@date-fns/tz';
import type { AuditLogFilters } from '../../api/practice';

/**
 * Kinds of activity the log can be narrowed to; each maps to one action prefix (the API filters by
 * a single prefix), so a few security actions have entries of their own.
 */
export const ACTION_CATEGORIES: { prefix: string; label: string }[] = [
  { prefix: 'auth.', label: 'Staff sign-ins, passwords and two-factor' },
  { prefix: 'security_event.', label: 'Security alerts' },
  { prefix: 'practice.security_update', label: 'Security settings changes' },
  { prefix: 'team.mfa_reset', label: 'Two-factor resets' },
  { prefix: 'team.sessions_revoked', label: 'Team members signed out everywhere' },
  { prefix: 'admin.', label: 'Server admin commands' },
  { prefix: 'client.emergency_access', label: 'Emergency access to charts' },
  { prefix: 'emergency_access.', label: 'Emergency access reviews' },
  { prefix: 'portal.', label: 'Client portal sign-ins' },
  { prefix: 'client.', label: 'Client records' },
  { prefix: 'note.', label: 'Notes' },
  { prefix: 'client_form.', label: 'Forms' },
  { prefix: 'file.', label: 'Documents' },
  { prefix: 'message', label: 'Messages' },
  { prefix: 'appointment', label: 'Appointments and requests' },
  { prefix: 'calendar_sync.', label: 'Calendar sync' },
  { prefix: 'telehealth.', label: 'Telehealth' },
  { prefix: 'invoice.', label: 'Invoices' },
  { prefix: 'payment.', label: 'Payments' },
  { prefix: 'superbill.', label: 'Superbills' },
  { prefix: 'billing.', label: 'Billing summaries' },
  { prefix: 'estimate.', label: 'Good faith estimates' },
  { prefix: 'claim.', label: 'Insurance claims' },
  { prefix: 'record_request.', label: 'Record requests' },
  { prefix: 'disclosure.', label: 'Disclosures' },
  { prefix: 'amendment.', label: 'Amendment requests' },
  { prefix: 'import.', label: 'Imports from SimplePractice' },
  { prefix: 'ai.', label: 'AI assistant' },
  { prefix: 'audit_log.', label: 'Audit log access' },
  { prefix: 'team.', label: 'Team changes' },
  { prefix: 'practice.', label: 'Practice settings' },
];

/** What the filter controls hold: dates are "YYYY-MM-DD" in the viewer's time zone. */
export interface AuditFilterForm {
  clientId: number | null;
  actorId: number | null;
  action: string;
  fromDay: string;
  toDay: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterForm = { clientId: null, actorId: null, action: '', fromDay: '', toDay: '' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** UTC ISO instant of local midnight at the start of `day` in `timeZone` (`offsetDays` later). */
export function dayStartIso(day: string, timeZone: string, offsetDays = 0): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(new TZDate(year, month - 1, date + offsetDays, timeZone).getTime()).toISOString();
}

/** A problem with the date range, or null. */
export function dateRangeProblem(form: Pick<AuditFilterForm, 'fromDay' | 'toDay'>): string | null {
  if (form.fromDay && form.toDay && form.fromDay > form.toDay) return 'The start date is after the end date';
  return null;
}

/**
 * API filters for the form. The "to" day is inclusive in the form and becomes the exclusive start
 * of the next day; invalid or reversed ranges leave the dates out.
 */
export function auditFiltersFrom(form: AuditFilterForm, timeZone: string): AuditLogFilters {
  const filters: AuditLogFilters = {};
  if (form.clientId !== null) filters.client_id = form.clientId;
  if (form.actorId !== null) filters.actor_id = form.actorId;
  if (form.action) filters.action = form.action;
  if (dateRangeProblem(form) === null) {
    if (DAY.test(form.fromDay)) filters.from = dayStartIso(form.fromDay, timeZone);
    if (DAY.test(form.toDay)) filters.to = dayStartIso(form.toDay, timeZone, 1);
  }
  return filters;
}

/** Whether any filter is set. */
export function hasFilters(form: AuditFilterForm): boolean {
  return (
    form.clientId !== null || form.actorId !== null || form.action !== '' || form.fromDay !== '' || form.toDay !== ''
  );
}

/** The first characters of a hash, enough to compare by eye. */
export function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 12) : '';
}
