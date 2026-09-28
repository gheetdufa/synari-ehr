import { Link } from 'react-router-dom';
import type { AuditActorRole, AuditEvent } from '../../api/practice';
import { formatDate, formatTime } from '../../lib/format';
import { Badge, Table, Td, Th } from '../../ui/Display';
import { actorLabel, humanizeAction, resourceLabel } from './auditActions';

function When({ iso, timeZone }: { iso: string; timeZone: string }) {
  return (
    <time dateTime={iso} className="whitespace-nowrap">
      {formatDate(iso, timeZone)} <span className="text-sage-500">{formatTime(iso, timeZone)}</span>
    </time>
  );
}

const ACTOR_TONES: Record<AuditActorRole, 'neutral' | 'info' | 'warning'> = {
  staff: 'neutral',
  client: 'info',
  system: 'neutral',
  anonymous: 'warning',
};

function Actor({ event, currentStaffId }: { event: AuditEvent; currentStaffId: number }) {
  const label = actorLabel(event, currentStaffId);
  return event.actor_role === 'staff' ? (
    <span className="text-sage-700">{label}</span>
  ) : (
    <Badge tone={ACTOR_TONES[event.actor_role]}>{label}</Badge>
  );
}

function ClientLink({ event }: { event: AuditEvent }) {
  if (event.client_id === null) return null;
  return (
    <Link to={`/portal/clients/${event.client_id}`} className="text-primary-700 hover:underline">
      {event.client_name || `Client #${event.client_id}`}
    </Link>
  );
}

/**
 * Audit events as a table (a list on phones): when, what, who, which client and record, and from
 * where. `showClient` adds the client column (left out on a client's own access history).
 */
export function AuditEventList({
  events,
  timeZone,
  currentStaffId,
  showClient = true,
  label,
}: {
  events: AuditEvent[];
  timeZone: string;
  currentStaffId: number;
  showClient?: boolean;
  label: string;
}) {
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <caption className="sr-only">{label}</caption>
          <thead className="bg-sage-50/60">
            <tr>
              <Th>Time</Th>
              <Th>Action</Th>
              <Th>By</Th>
              {showClient && <Th>Client</Th>}
              <Th>Record</Th>
              <Th>IP address</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sage-100">
            {events.map((event) => (
              <tr key={event.id}>
                <Td>
                  <When iso={event.created_at} timeZone={timeZone} />
                </Td>
                <Td>
                  <span title={event.action}>{humanizeAction(event.action)}</span>
                </Td>
                <Td>
                  <Actor event={event} currentStaffId={currentStaffId} />
                </Td>
                {showClient && (
                  <Td>
                    <ClientLink event={event} />
                  </Td>
                )}
                <Td className="text-sage-600">{resourceLabel(event.resource_type, event.resource_id)}</Td>
                <Td className="font-mono text-xs text-sage-600">
                  <span title={event.user_agent || undefined}>{event.ip_address}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ul className="divide-y divide-sage-100 md:hidden" aria-label={label}>
        {events.map((event) => (
          <li key={event.id} className="px-4 py-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium text-sage-900">{humanizeAction(event.action)}</p>
              <Actor event={event} currentStaffId={currentStaffId} />
            </div>
            <p className="mt-0.5 text-xs text-sage-500">
              <When iso={event.created_at} timeZone={timeZone} />
              {resourceLabel(event.resource_type, event.resource_id) &&
                ` · ${resourceLabel(event.resource_type, event.resource_id)}`}
              {event.ip_address && ` · ${event.ip_address}`}
            </p>
            {showClient && event.client_id !== null && (
              <p className="mt-0.5 text-xs">
                <ClientLink event={event} />
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
