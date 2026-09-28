import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Pencil, Plus, Video } from 'lucide-react';
import { practiceApi, practiceKeys, type Location } from '../../../api/practice';
import { useCan } from '../../../auth/StaffAuth';
import { Button, IconButton } from '../../../ui/Button';
import { Card, CardHeader } from '../../../ui/Card';
import { Badge, EmptyState, ErrorState } from '../../../ui/Display';
import { ConfirmDialog } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { LocationModal } from './LocationModal';
import { addressLine, placeOfServiceLabel } from './locationRules';

type Editing = { location: Location | null } | null;

/** The practice's offices and video offices. Deactivate a location instead of deleting it. */
export function LocationsSettings() {
  const canEdit = useCan('manage_practice');
  const queryClient = useQueryClient();
  const toast = useToast();
  const locations = useQuery({ queryKey: practiceKeys.locations, queryFn: practiceApi.locations });
  const [editing, setEditing] = useState<Editing>(null);
  const [deactivating, setDeactivating] = useState<Location | null>(null);
  const list = locations.data ?? [];

  const setActive = useMutation({
    mutationFn: ({ location, active }: { location: Location; active: boolean }) =>
      practiceApi.updateLocation(location.id, { is_active: active }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: practiceKeys.locations });
      setDeactivating(null);
      toast.success(saved.is_active ? `${saved.name} is active again` : `${saved.name} was deactivated`);
    },
    onError: (error) => {
      setDeactivating(null);
      toast.error(error);
    },
  });

  return (
    <Card>
      <CardHeader
        title="Locations"
        description={
          canEdit
            ? 'Offices and video offices where appointments take place.'
            : 'Offices and video offices where appointments take place. Only team members who manage the practice can change them.'
        }
        actions={
          canEdit && (
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ location: null })}>
              Add location
            </Button>
          )
        }
      />
      {locations.isPending && <SectionSpinner />}
      {locations.isError && <ErrorState error={locations.error} onRetry={() => void locations.refetch()} />}
      {locations.data && list.length === 0 && (
        <EmptyState icon={<MapPin />} title="No locations yet" description="Add the offices where you see clients." />
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-sage-100">
          {list.map((location) => {
            const Icon = location.is_video ? Video : MapPin;
            const address = addressLine(location);
            return (
              <li key={location.id} className={`flex items-start gap-3 px-5 py-4 ${location.is_active ? '' : 'bg-sage-50/60'}`}>
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-sage-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-sage-900">
                    {location.name}
                    {location.is_video && <Badge tone="info">Video</Badge>}
                    {!location.is_active && <Badge>Inactive</Badge>}
                  </p>
                  {address && <p className="mt-0.5 text-sm text-sage-600">{address}</p>}
                  <p className="mt-0.5 text-xs text-sage-500">Place of service {placeOfServiceLabel(location.place_of_service)}</p>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    {location.is_active ? (
                      <Button variant="ghost" size="sm" onClick={() => setDeactivating(location)}>
                        Deactivate
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={setActive.isPending && setActive.variables?.location.id === location.id}
                        onClick={() => setActive.mutate({ location, active: true })}
                      >
                        Reactivate
                      </Button>
                    )}
                    <IconButton label={`Edit ${location.name}`} onClick={() => setEditing({ location })}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing && <LocationModal location={editing.location} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deactivating !== null}
        title={`Deactivate ${deactivating?.name ?? 'this location'}?`}
        message="It won't be offered for new appointments. Past and already-booked appointments keep it, and you can reactivate it any time."
        confirmLabel="Deactivate"
        danger
        loading={setActive.isPending}
        onCancel={() => setDeactivating(null)}
        onConfirm={() => deactivating && setActive.mutate({ location: deactivating, active: false })}
      />
    </Card>
  );
}
