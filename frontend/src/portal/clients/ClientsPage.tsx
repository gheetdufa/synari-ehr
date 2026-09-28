import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight, Mail, Phone, Search, UserPlus, Users } from 'lucide-react';
import { clientKeys, clientsApi, type CareTeamMember, type ClientSummary } from '../../api/clients';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatPlainDate, fullName, initials } from '../../lib/format';
import { usePagedQuery } from '../../lib/paging';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, Table, Td, Th } from '../../ui/Display';
import { Input, Select } from '../../ui/Form';
import { LoadMore } from '../../ui/LoadMore';
import { SectionSpinner, Spinner } from '../../ui/Spinner';
import { AddClientModal } from './AddClientModal';
import { canAddClients, primaryClinician, useClinicians } from './clientPermissions';
import {
  CLIENT_STATUS_LABELS,
  CLIENT_STATUS_TONES,
  STATUS_FILTERS,
  ageOn,
  statusFilterFrom,
  todayIn,
  type ClientStatusFilter,
} from './clientHelpers';
import { useDebouncedValue } from './useDebouncedValue';

function Dob({ date, today }: { date: string | null; today: string }) {
  if (!date) return <span className="text-sage-400">—</span>;
  return (
    <span>
      {formatPlainDate(date)} <span className="text-sage-500">({ageOn(date, today)})</span>
    </span>
  );
}

/** "Dana Lee, LCSW", or "Dana Lee, LCSW +1" when others are on the care team too. */
export function careTeamLabel(careTeam: CareTeamMember[]): string {
  const primary = primaryClinician(careTeam) ?? careTeam[0];
  if (!primary) return '';
  return careTeam.length > 1 ? `${primary.name} +${careTeam.length - 1}` : primary.name;
}

function ClientTable({ clients, today }: { clients: ClientSummary[]; today: string }) {
  const navigate = useNavigate();
  return (
    <Table>
      <thead className="bg-sage-50/60">
        <tr>
          <Th>Name</Th>
          <Th>Status</Th>
          <Th>Clinician</Th>
          <Th>Email</Th>
          <Th>Phone</Th>
          <Th>Date of birth</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-sage-100 bg-white">
        {clients.map((client) => (
          <tr
            key={client.id}
            onClick={() => navigate(`/portal/clients/${client.id}`)}
            className="cursor-pointer transition-colors hover:bg-sage-50"
          >
            <Td>
              <Link
                to={`/portal/clients/${client.id}`}
                onClick={(event) => event.stopPropagation()}
                className="flex items-center gap-3 font-medium text-sage-900 hover:text-primary-700 focus:outline-none focus-visible:underline"
              >
                <Avatar label={initials(client)} className="h-8 w-8 text-xs" />
                {fullName(client)}
              </Link>
            </Td>
            <Td>
              <Badge tone={CLIENT_STATUS_TONES[client.status]}>{CLIENT_STATUS_LABELS[client.status]}</Badge>
            </Td>
            <Td className="whitespace-nowrap">
              {careTeamLabel(client.care_team) || <span className="text-sage-400">—</span>}
            </Td>
            <Td className="max-w-[16rem] truncate">{client.email || <span className="text-sage-400">—</span>}</Td>
            <Td className="whitespace-nowrap">{client.phone || <span className="text-sage-400">—</span>}</Td>
            <Td className="whitespace-nowrap">
              <Dob date={client.date_of_birth} today={today} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ClientCards({ clients, today }: { clients: ClientSummary[]; today: string }) {
  return (
    <ul className="divide-y divide-sage-100">
      {clients.map((client) => (
        <li key={client.id}>
          <Link
            to={`/portal/clients/${client.id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-sage-50 focus:outline-none focus-visible:bg-sage-50"
          >
            <Avatar label={initials(client)} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium text-sage-900">{fullName(client)}</span>
                <Badge tone={CLIENT_STATUS_TONES[client.status]}>{CLIENT_STATUS_LABELS[client.status]}</Badge>
              </div>
              <div className="mt-0.5 space-y-0.5 text-xs text-sage-600">
                {client.care_team.length > 0 && <p>With {careTeamLabel(client.care_team)}</p>}
                {client.email && (
                  <p className="flex items-center gap-1.5 truncate">
                    <Mail className="h-3 w-3 shrink-0" aria-hidden="true" /> {client.email}
                  </p>
                )}
                {client.phone && (
                  <p className="flex items-center gap-1.5">
                    <Phone className="h-3 w-3 shrink-0" aria-hidden="true" /> {client.phone}
                  </p>
                )}
                {client.date_of_birth && (
                  <p>
                    Born <Dob date={client.date_of_birth} today={today} />
                  </p>
                )}
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The clinician filter from `?clinician=`, or null for everyone. */
function clinicianFilterFrom(value: string | null): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Client list with server-side search and status filter, plus a clinician filter for roles that
 * see every client. "Add client" opens the create dialog for roles that may add clients.
 */
export default function ClientsPage() {
  const session = useSession();
  const seesEveryone = useCan('view_all_clients');
  const mayAdd = canAddClients(session);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const status = statusFilterFrom(params.get('status'));
  const clinicianId = seesEveryone ? clinicianFilterFrom(params.get('clinician')) : null;
  const adding = mayAdd && params.get('new') === '1';
  const today = todayIn(session.staff.time_zone);
  const clinicians = useClinicians(seesEveryone);

  const query = {
    status: status === 'all' ? undefined : status,
    q: debouncedSearch || undefined,
    clinician_id: clinicianId ?? undefined,
  };
  const clients = usePagedQuery({
    queryKey: clientKeys.list(query),
    fetchPage: (page) => clientsApi.list({ ...query, ...page }),
    keepPreviousPages: true,
  });

  const updateParams = (change: (next: URLSearchParams) => void) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        change(next);
        return next;
      },
      { replace: true },
    );

  const setStatus = (value: ClientStatusFilter) =>
    updateParams((next) => (value === 'active' ? next.delete('status') : next.set('status', value)));
  const setClinician = (value: string) =>
    updateParams((next) => (value ? next.set('clinician', value) : next.delete('clinician')));
  const setAdding = (open: boolean) => updateParams((next) => (open ? next.set('new', '1') : next.delete('new')));

  const filtered = Boolean(debouncedSearch) || status !== 'active' || clinicianId !== null;
  const list = clients.items;
  const statusLabel = STATUS_FILTERS.find((option) => option.value === status)?.label.toLowerCase() ?? '';
  const addButton = (size?: 'sm') => (
    <Button size={size} icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>
      Add client
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Clients"
        description={
          clients.data
            ? `${clients.total.toLocaleString()} ${clients.total === 1 ? 'client' : 'clients'}${debouncedSearch ? ' found' : ''}`
            : seesEveryone
              ? 'Everyone in your practice'
              : 'Your caseload'
        }
        actions={mayAdd && addButton()}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-sage-100 p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sage-400" aria-hidden="true" />
            <Input
              type="search"
              aria-label="Search clients"
              placeholder="Search by name, email or phone"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9 pr-9"
            />
            {clients.isFetching && !clients.isPending && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-primary-600">
                <Spinner className="h-4 w-4" />
              </span>
            )}
          </div>
          {seesEveryone && (
            <Select
              aria-label="Filter by clinician"
              value={clinicianId ? String(clinicianId) : ''}
              onChange={(event) => setClinician(event.target.value)}
              className="sm:w-56"
            >
              <option value="">All clinicians</option>
              {(clinicians.data ?? []).map((member) => (
                <option key={member.id} value={member.id}>
                  {member.display_name}
                </option>
              ))}
            </Select>
          )}
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as ClientStatusFilter)}
            className="sm:w-52"
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {clients.isPending && <SectionSpinner />}
        {clients.isError && !clients.data && <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />}
        {clients.data && list.length === 0 && (
          <EmptyState
            icon={<Users />}
            title={filtered ? 'No matching clients' : 'No clients yet'}
            description={
              debouncedSearch
                ? `Nobody ${statusLabel ? `in "${statusLabel}" ` : ''}matches that search.`
                : filtered
                  ? `There are no ${statusLabel} clients${clinicianId ? ' for this clinician' : ''}.`
                  : mayAdd
                    ? 'Add your first client to start scheduling, messaging and sharing forms.'
                    : 'Clients appear here once they are added to the practice.'
            }
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSearch('');
                    updateParams((next) => {
                      next.delete('status');
                      next.delete('clinician');
                    });
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                mayAdd && addButton('sm')
              )
            }
          />
        )}
        {list.length > 0 && (
          <>
            <div className="hidden md:block">
              <ClientTable clients={list} today={today} />
            </div>
            <div className="md:hidden">
              <ClientCards clients={list} today={today} />
            </div>
            <LoadMore noun="clients" {...clients.loadMore} />
          </>
        )}
      </Card>

      {mayAdd && (
        <AddClientModal
          open={adding}
          today={today}
          onClose={() => setAdding(false)}
          onCreated={(client) => navigate(`/portal/clients/${client.id}`)}
        />
      )}
    </div>
  );
}
