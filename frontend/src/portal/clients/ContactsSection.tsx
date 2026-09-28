import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Pencil, Phone, Plus, Send, Trash2, UsersRound } from 'lucide-react';
import { clientKeys, clientsApi, type ClientContact, type ClientDetail } from '../../api/clients';
import { useSession } from '../../auth/StaffAuth';
import { formatDateTime, timeAgo } from '../../lib/format';
import { Button, IconButton } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, Badge, EmptyState } from '../../ui/Display';
import { ConfirmDialog } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { contactName, portalOpen } from './clientHelpers';
import { useClientPermissions } from './clientPermissions';
import { ContactModal } from './ContactModal';

type Dialog = { kind: 'edit'; contact: ClientContact | null } | { kind: 'delete'; contact: ClientContact } | null;

/** "Last portal sign-in 3d ago" or "Hasn't signed in yet" for a contact with portal access. */
export function contactPortalText(contact: ClientContact): string {
  return contact.portal_last_login_at
    ? `Last portal sign-in ${timeAgo(contact.portal_last_login_at)}`
    : "Hasn't signed in to the portal yet";
}

function ContactRow({
  contact,
  canEdit,
  canInvite,
  inviting,
  timeZone,
  onInvite,
  onEdit,
  onDelete,
}: {
  contact: ClientContact;
  canEdit: boolean;
  canInvite: boolean;
  inviting: boolean;
  timeZone: string;
  onInvite: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const name = contactName(contact);
  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-sage-900">
            {name}
            {contact.relation && <span className="font-normal text-sage-500"> · {contact.relation}</span>}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {contact.is_guardian && <Badge tone="primary">Guardian</Badge>}
            {contact.is_emergency_contact && <Badge tone="warning">Emergency contact</Badge>}
            {contact.responsible_for_billing && <Badge tone="info">Billing contact</Badge>}
            {contact.portal_access && <Badge tone="success">Portal access</Badge>}
          </div>
          <ul className="mt-2 space-y-1 text-sm text-sage-600">
            {contact.email && (
              <li className="flex min-w-0 items-center gap-1.5">
                <Mail className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
                <a href={`mailto:${contact.email}`} className="truncate hover:text-primary-700 hover:underline">
                  {contact.email}
                </a>
              </li>
            )}
            {contact.phone && (
              <li className="flex items-center gap-1.5">
                <Phone className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
                <a href={`tel:${contact.phone}`} className="hover:text-primary-700 hover:underline">
                  {contact.phone}
                </a>
              </li>
            )}
            {contact.portal_access && (
              <li
                className="text-xs text-sage-500"
                title={contact.portal_last_login_at ? formatDateTime(contact.portal_last_login_at, timeZone) : undefined}
              >
                {contactPortalText(contact)}
              </li>
            )}
          </ul>
          {canInvite && (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3 mt-1"
              icon={<Send className="h-3.5 w-3.5" />}
              loading={inviting}
              onClick={onInvite}
              aria-label={`${contact.portal_last_login_at ? 'Resend' : 'Send'} portal invite to ${name}`}
            >
              {contact.portal_last_login_at ? 'Resend portal invite' : 'Send portal invite'}
            </Button>
          )}
        </div>
        {canEdit && (
          <div className="flex shrink-0 gap-1">
            <IconButton label={`Edit ${name}`} onClick={onEdit}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton label={`Remove ${name}`} onClick={onDelete} className="hover:text-red-700">
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
    </li>
  );
}

/** Guardians, family, emergency and billing contacts, with portal invitations for those with access. */
export function ContactsSection({ client }: { client: ClientDetail }) {
  const { staff } = useSession();
  const { editProfile } = useClientPermissions(client);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);

  const invite = useMutation({
    mutationFn: (contact: ClientContact) => clientsApi.contacts.invite(client.id, contact.id),
    onSuccess: (result) => toast.success(result.detail),
    onError: (error) => toast.error(error),
  });

  const remove = useMutation({
    mutationFn: (contact: ClientContact) => clientsApi.contacts.remove(client.id, contact.id),
    onSuccess: (_, contact) => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.detail(client.id) });
      toast.success(`${contactName(contact)} was removed`);
      setDialog(null);
    },
    onError: (error) => {
      toast.error(error);
      setDialog(null);
    },
  });

  const needsGuardian = client.is_minor && !client.contacts.some((contact) => contact.is_guardian);
  const invitesOpen = editProfile && portalOpen(client);

  return (
    <Card>
      <CardHeader
        title="Contacts"
        description={client.is_minor ? 'Parents, guardians and emergency contacts' : 'Family, emergency and billing contacts'}
        actions={
          editProfile && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setDialog({ kind: 'edit', contact: null })}
            >
              Add contact
            </Button>
          )
        }
      />
      {needsGuardian && (
        <CardBody className="pb-0">
          <Alert tone="warning">This client is a minor. Add a parent or legal guardian.</Alert>
        </CardBody>
      )}
      {client.contacts.length === 0 ? (
        <EmptyState
          icon={<UsersRound />}
          title="No contacts yet"
          description="Add guardians, emergency contacts or someone responsible for billing."
        />
      ) : (
        <ul className="divide-y divide-sage-100">
          {client.contacts.map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              canEdit={editProfile}
              canInvite={invitesOpen && contact.portal_access && Boolean(contact.email)}
              inviting={invite.isPending && invite.variables?.id === contact.id}
              timeZone={staff.time_zone}
              onInvite={() => invite.mutate(contact)}
              onEdit={() => setDialog({ kind: 'edit', contact })}
              onDelete={() => setDialog({ kind: 'delete', contact })}
            />
          ))}
        </ul>
      )}

      {dialog?.kind === 'edit' && (
        <ContactModal client={client} contact={dialog.contact} onClose={() => setDialog(null)} />
      )}
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="Remove this contact?"
        danger
        confirmLabel="Remove contact"
        loading={remove.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => dialog?.kind === 'delete' && remove.mutate(dialog.contact)}
        message={
          dialog?.kind === 'delete' && (
            <p>
              Remove <strong>{contactName(dialog.contact)}</strong> from this client&apos;s contacts?
              {dialog.contact.portal_access && ' They will be signed out of the portal.'}
            </p>
          )
        }
      />
    </Card>
  );
}
