import type { PortalAmendmentRequest, PortalRecordRequest } from '../../api/portalRecords';
import { formatDate, formatPlainDate } from '../../lib/format';

export type StatusTone = 'info' | 'warning' | 'success' | 'neutral' | 'danger';

/** How a request's status reads in the portal: a badge plus one line of explanation. */
export interface StatusView {
  label: string;
  tone: StatusTone;
  detail: string;
}

/** The badge and explanation for a request for a copy of the record. */
export function recordRequestStatus(request: PortalRecordRequest, timeZone: string): StatusView {
  if (request.status === 'denied') {
    return {
      label: 'Denied',
      tone: 'danger',
      detail: request.denial_reason ? `Reason: ${request.denial_reason}` : 'The practice denied this request.',
    };
  }
  if (request.status === 'fulfilled') {
    const sentOn = request.fulfilled_at ? ` on ${formatDate(request.fulfilled_at, timeZone)}` : '';
    if (request.delivery === 'third_party') {
      return { label: 'Sent', tone: 'success', detail: `Sent to the person you named${sentOn}.` };
    }
    if (request.release_available) {
      return {
        label: 'Ready to download',
        tone: 'success',
        detail: request.release_expires_at
          ? `Available until ${formatDate(request.release_expires_at, timeZone)}.`
          : `Released${sentOn}.`,
      };
    }
    return {
      label: 'Expired',
      tone: 'neutral',
      detail: request.release_expires_at
        ? `The download expired on ${formatDate(request.release_expires_at, timeZone)}. Ask again if you need another copy.`
        : 'The download is no longer available. Ask again if you need another copy.',
    };
  }
  if (request.extended_on) {
    const reason = request.extension_reason ? ` Reason: ${request.extension_reason}` : '';
    return {
      label: 'Extended',
      tone: 'warning',
      detail: `The practice needs more time and will respond by ${formatPlainDate(request.due_on)}.${reason}`,
    };
  }
  return { label: 'In progress', tone: 'info', detail: `The practice will respond by ${formatPlainDate(request.due_on)}.` };
}

/** The badge and explanation for a request to amend the record. */
export function amendmentStatus(amendment: PortalAmendmentRequest, timeZone: string): StatusView {
  if (amendment.status === 'accepted') {
    const on = amendment.decided_at ? ` on ${formatDate(amendment.decided_at, timeZone)}` : '';
    return { label: 'Accepted', tone: 'success', detail: `The practice added your correction to your record${on}.` };
  }
  if (amendment.status === 'denied') {
    return {
      label: 'Denied',
      tone: 'danger',
      detail: amendment.denial_reason ? `Reason: ${amendment.denial_reason}` : 'The practice denied this request.',
    };
  }
  return { label: 'Under review', tone: 'info', detail: `The practice will decide by ${formatPlainDate(amendment.due_on)}.` };
}
