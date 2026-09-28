import type { Claim, UnbilledSession } from '../../../api/claims';
import { formatPlainDate } from '../../../lib/format';
import type { Tone } from '../labels';

export interface SessionWarning {
  kind: 'unsigned_note' | 'no_diagnosis' | 'eligibility';
  label: string;
  tone: Tone;
}

/** What might get a claim for this session denied or held back. */
export function sessionWarnings(session: UnbilledSession): SessionWarning[] {
  const warnings: SessionWarning[] = [];
  if (!session.note_signed) warnings.push({ kind: 'unsigned_note', label: 'Note not signed', tone: 'warning' });
  if (!session.has_diagnoses) warnings.push({ kind: 'no_diagnosis', label: 'No diagnosis', tone: 'danger' });
  if (session.eligibility_status === 'inactive') {
    warnings.push({ kind: 'eligibility', label: 'Coverage inactive', tone: 'danger' });
  } else if (session.eligibility_status === 'review') {
    warnings.push({ kind: 'eligibility', label: 'Eligibility needs review', tone: 'warning' });
  } else if (session.eligibility_status === 'error') {
    warnings.push({ kind: 'eligibility', label: "Eligibility couldn't be checked", tone: 'neutral' });
  }
  return warnings;
}

export interface ClientSessions {
  clientId: number;
  clientName: string;
  payerNames: string[];
  sessions: UnbilledSession[];
}

/** Sessions grouped by client (a claim covers one client), in the order the sessions come in. */
export function groupByClient(sessions: UnbilledSession[]): ClientSessions[] {
  const groups = new Map<number, ClientSessions>();
  for (const session of sessions) {
    const group = groups.get(session.client_id) ?? {
      clientId: session.client_id,
      clientName: session.client_name,
      payerNames: [],
      sessions: [],
    };
    group.sessions.push(session);
    if (!group.payerNames.includes(session.payer_name)) group.payerNames.push(session.payer_name);
    groups.set(session.client_id, group);
  }
  return [...groups.values()];
}

/** One sentence per kind of warning among the chosen sessions, for the confirmation step. */
export function selectionWarnings(sessions: UnbilledSession[]): string[] {
  const count = (kind: SessionWarning['kind']) =>
    sessions.filter((session) => sessionWarnings(session).some((warning) => warning.kind === kind)).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const messages: string[] = [];
  const unsigned = count('unsigned_note');
  if (unsigned) messages.push(`${plural(unsigned, 'session has', 'sessions have')} no signed note.`);
  const undiagnosed = count('no_diagnosis');
  if (undiagnosed) {
    messages.push(
      `${plural(undiagnosed, 'session is', 'sessions are')} for a client without a diagnosis; add one before submitting.`,
    );
  }
  const eligibility = count('eligibility');
  if (eligibility) {
    messages.push(`${plural(eligibility, 'session has', 'sessions have')} inactive or unconfirmed coverage.`);
  }
  return messages;
}

/** Create claims for the chosen sessions, one request per client. Failures don't stop the rest. */
export async function createClaimsFor(
  sessions: UnbilledSession[],
  create: (participantIds: number[]) => Promise<Claim[]>,
): Promise<{ created: Claim[]; failures: { clientName: string; message: string }[] }> {
  const created: Claim[] = [];
  const failures: { clientName: string; message: string }[] = [];
  for (const group of groupByClient(sessions)) {
    try {
      created.push(...(await create(group.sessions.map((session) => session.participant_id))));
    } catch (error) {
      failures.push({ clientName: group.clientName, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { created, failures };
}

/** "Sep 3, 2026" or "Sep 3, 2026 – Sep 17, 2026" for a claim's dates of service. */
export function serviceDates(claim: Pick<Claim, 'first_service_date' | 'last_service_date'>): string {
  const { first_service_date: first, last_service_date: last } = claim;
  if (!first) return '';
  if (!last || last === first) return formatPlainDate(first);
  return `${formatPlainDate(first)} – ${formatPlainDate(last)}`;
}
