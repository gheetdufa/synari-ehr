import type { AuditEvent } from '../../api/practice';

/** Plain-English labels for audit log actions ("client.view" -> "Viewed client"). */
const EXACT: Record<string, string> = {
  'account.calendar_feed_created': 'Created a calendar subscription link',
  'account.calendar_feed_deleted': 'Turned off their calendar subscription link',
  'account.preferences_update': 'Updated their preferences',
  'account.profile_update': 'Updated their profile',
  'account.register': 'Created the practice',
  'admin.create_owner': 'Server admin added an owner',
  'admin.mfa_reset': 'Server admin reset two-factor authentication',
  'admin.unlock': 'Server admin unlocked sign-in',
  'ai.assistant': 'Asked the AI assistant',
  'ai.note_generate': 'Drafted a note with AI',
  'ai.transcribe': 'Transcribed audio with AI',
  'amendment.accept': 'Accepted an amendment request',
  'amendment.create': 'Recorded an amendment request',
  'amendment.deny': 'Denied an amendment request',
  'amendment.disagreement': 'Filed a statement of disagreement',
  'amendment.list': 'Viewed amendment requests',
  'amendment.rebuttal': 'Added a rebuttal to a disagreement',
  'amendment.view': 'Viewed an amendment request',
  'appointment.list': 'Viewed appointments',
  'appointment.participant_update': "Updated a client's attendance or billing for a session",
  'appointment.view': 'Viewed an appointment',
  'appointment_request.accept': 'Accepted an appointment request',
  'appointment_request.create': 'Requested an appointment',
  'appointment_request.decline': 'Declined an appointment request',
  'appointment_request.list': 'Viewed appointment requests',
  'audit_log.export': 'Exported the activity log',
  'audit_log.view': 'Viewed the activity log',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in attempt',
  'auth.logout': 'Signed out',
  'auth.logout_everywhere': 'Signed out everywhere',
  'auth.mfa_disabled': 'Turned off two-factor authentication',
  'auth.mfa_enabled': 'Turned on two-factor authentication',
  'auth.mfa_failed': 'Entered a wrong two-factor code',
  'auth.mfa_recovery_codes_regenerated': 'Created new recovery codes',
  'auth.mfa_setup_started': 'Started two-factor setup',
  'auth.password_changed': 'Changed password',
  'auth.password_reset': 'Reset password',
  'auth.password_reset_requested': 'Requested a password reset',
  'auth.refresh': 'Refreshed their session',
  'auth.session_revoked': 'Signed out a device',
  'authorization.create': 'Added a prior authorization',
  'authorization.delete': 'Deleted a prior authorization',
  'authorization.list': 'Viewed prior authorizations',
  'authorization.update': 'Updated a prior authorization',
  'availability.update': 'Updated availability',
  'billing.summary_view': 'Viewed billing summary',
  'billing.uninvoiced_list': 'Viewed uninvoiced appointments',
  'calendar_sync.connect': 'Connected a Google or Outlook calendar',
  'calendar_sync.disconnect': 'Disconnected a Google or Outlook calendar',
  'calendar_sync.sync': 'Synced their connected calendar',
  'calendar_sync.update': 'Changed which calendars block their availability',
  'card.default': 'Changed the default card',
  'card.list': 'Viewed saved cards',
  'card.save': 'Saved a card',
  'card.set_default': 'Changed the default card',
  'card.setup': 'Saved a card',
  'claim.correct': 'Started a corrected claim',
  'claim.secondary': 'Started a secondary claim',
  'claim.submit': 'Submitted a claim',
  'claims.unbilled_list': 'Viewed sessions not yet billed to insurance',
  'client.access_history_view': "Viewed a client's access history",
  'client.autopay_disabled': 'Turned off AutoPay after declined charges',
  'client.care_team': "Changed a client's care team",
  'client.emergency_access': 'Used emergency access to a client record',
  'client.export': "Exported a client's record",
  'client.list': 'Viewed the client list',
  'client.portal_invite': 'Sent a portal invitation',
  'client.sms_opt_in': 'Opted in to text messages',
  'client.sms_opt_out': 'Opted out of text messages',
  'client_contact.list': "Viewed a client's contacts",
  'client_contact.portal_invite': "Sent a portal invitation to a client's contact",
  'client_form.download_pdf': 'Downloaded a completed form',
  'client_form.remind': 'Sent a form reminder',
  'client_form.revoke': 'Revoked a shared form',
  'client_form.share': 'Shared a form',
  'client_form.submit': 'Submitted a form',
  'conversation.open': 'Started a conversation',
  'dashboard.view': 'Viewed the dashboard',
  'disclosure.create': 'Recorded a disclosure',
  'disclosure.delete': 'Deleted a disclosure',
  'disclosure.list': 'Viewed disclosures',
  'disclosure.report': 'Viewed an accounting of disclosures',
  'disclosure.update': 'Updated a disclosure',
  'eligibility.check': 'Checked insurance eligibility',
  'eligibility.list': 'Viewed eligibility checks',
  'emergency_access.list': 'Viewed emergency access',
  'emergency_access.review': 'Reviewed emergency access',
  'emergency_access.revoke': 'Ended emergency access',
  'estimate.acknowledge': 'Acknowledged a good faith estimate',
  'estimate.create': 'Started a good faith estimate',
  'estimate.delete': 'Deleted a good faith estimate draft',
  'estimate.download': 'Downloaded a good faith estimate',
  'estimate.issue': 'Issued a good faith estimate',
  'estimate.list': 'Viewed good faith estimates',
  'estimate.needed_list': 'Viewed clients who need a good faith estimate',
  'estimate.options_view': 'Opened the good faith estimate form',
  'estimate.request': 'Requested a good faith estimate',
  'estimate.supersede': 'Started an updated good faith estimate',
  'estimate.update': 'Updated a good faith estimate draft',
  'estimate.view': 'Viewed a good faith estimate',
  'estimate.void': 'Voided a good faith estimate',
  'file.list': "Viewed a client's documents",
  'import.analyze': 'Analyzed files for an import',
  'import.analyzed': 'Finished analyzing an import',
  'import.cancel': 'Canceled an import',
  'import.completed': 'Finished an import',
  'import.create': 'Started an import from SimplePractice',
  'import.failed': 'An import failed',
  'import.remove_file': 'Removed a file from an import',
  'import.start': 'Started importing records',
  'import.upload': 'Uploaded a file for an import',
  'insurance.create': 'Added an insurance policy',
  'insurance.delete': 'Removed an insurance policy',
  'insurance.list': "Viewed a client's insurance",
  'insurance.settings_update': 'Updated insurance claim settings',
  'insurance.update': 'Updated an insurance policy',
  'invoice.adjustment_create': 'Billed what insurance says the client owes',
  'invoice.auto_create': 'Created an invoice automatically',
  'invoice.dispute': 'Marked an invoice as disputed',
  'invoice.dispute_resolve': 'Resolved an invoice dispute',
  'invoice.estimate_check': 'Checked an invoice against good faith estimates',
  'message.send': 'Sent a message',
  'message_attachment.upload': 'Uploaded a message attachment',
  'messages.list': 'Viewed conversations',
  'messages.view': 'Viewed a conversation',
  'note.addenda_view': "Viewed a note's addenda",
  'note.addendum_create': 'Added an addendum to a note',
  'note.cosign': 'Co-signed a note',
  'note.cosign_queue': 'Viewed notes waiting for co-signature',
  'note.list': 'Viewed notes',
  'note.request_changes': 'Requested changes to a note',
  'note.revisions_view': "Viewed a note's history",
  'payment.autopay': 'Charged a card with AutoPay',
  'payment.card_failed': 'A card payment failed',
  'payment.card_succeeded': 'A card payment went through',
  'payment.charge': 'Charged a saved card',
  'payment.checkout': 'Started an online payment',
  'payment.create': 'Recorded a payment',
  'payment.refund': 'Refunded a payment',
  'payment.refund_synced': 'Recorded a refund made in Stripe',
  'portal.login': 'Signed in to the client portal',
  'portal.logout': 'Signed out of the client portal',
  'portal.logout_everywhere': 'Signed out of the client portal everywhere',
  'portal.refresh': 'Refreshed a client portal session',
  'portal.request_link': 'Requested a portal sign-in link',
  'practice.location_create': 'Added a location',
  'practice.location_update': 'Updated a location',
  'practice.security_update': 'Changed security settings',
  'practice.settings_update': 'Updated practice settings',
  'practice.update': 'Updated practice details',
  'record_request.create': 'Recorded a request for records',
  'record_request.deny': 'Denied a request for records',
  'record_request.extend': 'Extended a request for records',
  'record_request.fulfill': 'Fulfilled a request for records',
  'record_request.list': 'Viewed requests for records',
  'record_request.package_download': 'Downloaded a records package',
  'record_request.release_download': 'Downloaded released records',
  'record_request.view': 'Viewed a request for records',
  'recording.create': 'Saved a session recording',
  'recording.transcribe': 'Transcribed a session recording',
  'remittance.download': 'Downloaded a remittance file',
  'remittance.post': 'Posted an insurance remittance',
  'retention.report_view': 'Viewed the records retention report',
  'security_event.acknowledge': 'Acknowledged a security event',
  'team.deactivate': 'Deactivated a team member',
  'team.invitation_accepted': 'Joined the practice',
  'team.invite': 'Invited a team member',
  'team.invite_resent': 'Resent an invitation',
  'team.invite_revoked': 'Withdrew an invitation',
  'team.mfa_reset': "Reset a team member's two-factor authentication",
  'team.rates_update': "Updated a clinician's services and rates",
  'team.reactivate': 'Reactivated a team member',
  'team.sessions_revoked': 'Signed a team member out everywhere',
  'team.update': 'Updated a team member',
  'telehealth.admit': 'Admitted a client from the waiting room',
  'telehealth.admit_all': 'Admitted everyone from the waiting room',
  'telehealth.decline': 'Declined a waiting-room entry',
  'telehealth.end': 'Ended a telehealth session',
  'telehealth.enter': 'Entered the telehealth waiting room',
  'telehealth.guest_info': 'Opened a telehealth join link',
  'telehealth.host_join': 'Started a telehealth session',
  'telehealth.join_link_view': 'Opened their telehealth link',
  'telehealth.join_links_view': 'Viewed telehealth join links',
  'telehealth.leave': 'Left a telehealth session',
  'telehealth.link_send': 'Sent a telehealth link',
  'telehealth.recording_consent_view': 'Checked recording consent',
  'telehealth.remove': 'Removed someone from a telehealth session',
  'telehealth.waiting_room_view': 'Viewed the waiting room',
};

const VERBS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  view: 'Viewed',
  list: 'Viewed',
  download: 'Downloaded',
  upload: 'Uploaded',
  remove: 'Removed',
  void: 'Voided',
  cancel: 'Canceled',
  sign: 'Signed',
  unlock: 'Unlocked',
  share: 'Shared',
  unshare: 'Stopped sharing',
  send: 'Sent',
};

function plural(noun: string): string {
  return noun.endsWith('s') ? noun : `${noun}s`;
}

export function humanizeAction(action: string): string {
  const exact = EXACT[action];
  if (exact) return exact;
  const dot = action.indexOf('.');
  const resource = (dot === -1 ? action : action.slice(0, dot)).replace(/_/g, ' ');
  const verb = dot === -1 ? '' : action.slice(dot + 1);
  const lead = VERBS[verb];
  if (lead) {
    if (verb === 'list') return `${lead} ${plural(resource)}`;
    return `${lead} ${/^[aeiou]/.test(resource) ? 'an' : 'a'} ${resource}`;
  }
  const words = `${resource} ${verb.replace(/_/g, ' ')}`.trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const RESOURCE_NAMES: Record<string, string> = { staff: 'team member' };

/** "Client #12" style label for the record an event touched. */
export function resourceLabel(resourceType: string, resourceId: number | null): string {
  if (!resourceType) return '';
  const name = RESOURCE_NAMES[resourceType] ?? resourceType.replace(/_/g, ' ');
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return resourceId === null ? label : `${label} #${resourceId}`;
}

/**
 * Who did it: "You", a team member's name, the client (named when the event is about their own
 * record; a contact such as a guardian signed in to their portal is noted in `detail`), Synari for
 * background jobs, the server admin for admin commands, or someone who wasn't signed in.
 */
export function actorLabel(
  event: Pick<AuditEvent, 'actor_role' | 'actor_id' | 'actor_name' | 'client_id' | 'client_name' | 'action' | 'detail'>,
  currentStaffId: number,
): string {
  const { actor_role: role, actor_id: actorId } = event;
  if (role === 'staff') {
    if (actorId === currentStaffId) return 'You';
    return event.actor_name || (actorId === null ? 'Team member' : `Team member #${actorId}`);
  }
  if (role === 'client') {
    const ownRecord = actorId !== null && actorId === event.client_id;
    const client = (ownRecord && event.client_name) || (actorId === null ? 'Client' : `Client #${actorId}`);
    return event.detail?.contact_id != null ? `${client}'s contact` : client;
  }
  if (role === 'system') return event.action.startsWith('admin.') ? 'Server admin' : 'Synari (automatic)';
  return 'Not signed in';
}
