import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Tag } from 'lucide-react';
import { practiceApi, practiceKeys, type Service } from '../../api/practice';
import { useCan } from '../../auth/StaffAuth';
import { formatMoney } from '../../lib/format';
import { Button, IconButton } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, EmptyState, ErrorState, Table, Td, Th } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { ServiceModal } from './ServiceModal';

type Editing = { service: Service | null } | null;

function YesNo({ value, label }: { value: boolean; label: string }) {
  return value ? <Badge tone="success">Yes</Badge> : <span className="text-sage-400" aria-label={`${label}: no`}>—</span>;
}

function ServiceBadges({ service }: { service: Service }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {service.is_default && <Badge tone="primary">Default</Badge>}
      {!service.is_active && <Badge>Inactive</Badge>}
      {service.bookable_online && <Badge tone="info">Online requests</Badge>}
      {service.bookable_online && service.bookable_by_new_clients && <Badge tone="info">New clients</Badge>}
    </div>
  );
}

function ServiceSummary({ service }: { service: Service }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-sage-900">
        <span className="font-mono text-xs text-sage-600">{service.code}</span> {service.description}
      </p>
      <p className="mt-0.5 text-sm text-sage-600">
        {service.duration_minutes} min · {formatMoney(service.rate_cents)}
      </p>
      <div className="mt-1.5">
        <ServiceBadges service={service} />
      </div>
    </div>
  );
}

/** Services and rates: codes, lengths and fees, the default, and which can be requested online. Only
 * people who manage the practice can change them. */
export function ServicesSettings() {
  const canEdit = useCan('manage_practice');
  const services = useQuery({ queryKey: practiceKeys.services, queryFn: practiceApi.services });
  const [editing, setEditing] = useState<Editing>(null);
  const list = services.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Services & rates"
        description={
          canEdit
            ? "The practice's services and standard rates. Services can't be deleted once used; turn one off to retire it."
            : "The practice's services and standard rates. Only team members who manage the practice can change them."
        }
        actions={
          canEdit && (
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ service: null })}>
              Add service
            </Button>
          )
        }
      />
      {services.isPending && <SectionSpinner />}
      {services.isError && <ErrorState error={services.error} onRetry={() => void services.refetch()} />}
      {services.data && list.length === 0 && (
        <EmptyState
          icon={<Tag />}
          title="No services yet"
          description="Add the services the practice offers with their usual length and fee."
        />
      )}
      {list.length > 0 && (
        <>
          <div className="hidden lg:block">
            <Table>
              <thead className="bg-sage-50/60">
                <tr>
                  <Th>Code</Th>
                  <Th>Description</Th>
                  <Th className="text-right">Length</Th>
                  <Th className="text-right">Rate</Th>
                  <Th>Default</Th>
                  <Th>Active</Th>
                  <Th>Online</Th>
                  <Th>New clients</Th>
                  {canEdit && (
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-sage-100">
                {list.map((service) => (
                  <tr key={service.id} className={service.is_active ? '' : 'text-sage-500'}>
                    <Td className="font-mono text-xs">{service.code}</Td>
                    <Td className={service.is_active ? '' : 'text-sage-500'}>{service.description}</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">{service.duration_minutes} min</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">{formatMoney(service.rate_cents)}</Td>
                    <Td>{service.is_default ? <Badge tone="primary">Default</Badge> : null}</Td>
                    <Td>
                      <YesNo value={service.is_active} label="Active" />
                    </Td>
                    <Td>
                      <YesNo value={service.bookable_online} label="Online requests" />
                    </Td>
                    <Td>
                      <YesNo value={service.bookable_online && service.bookable_by_new_clients} label="New clients" />
                    </Td>
                    {canEdit && (
                      <Td className="text-right">
                        <IconButton label={`Edit ${service.code}`} onClick={() => setEditing({ service })}>
                          <Pencil className="h-4 w-4" />
                        </IconButton>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <ul className="divide-y divide-sage-100 lg:hidden">
            {list.map((service) => (
              <li key={service.id}>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setEditing({ service })}
                    className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-sage-50 focus:outline-none focus-visible:bg-sage-50"
                    aria-label={`Edit ${service.code} ${service.description}`}
                  >
                    <ServiceSummary service={service} />
                    <Pencil className="mt-1 h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
                  </button>
                ) : (
                  <div className="px-5 py-3">
                    <ServiceSummary service={service} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {editing && <ServiceModal service={editing.service} onClose={() => setEditing(null)} />}
    </Card>
  );
}
