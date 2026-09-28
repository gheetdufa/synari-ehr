import { Check, Minus } from 'lucide-react';
import type { ClientDetail } from '../../api/clients';
import { usePublicConfig } from '../../lib/usePublicConfig';
import { Alert } from '../../ui/Display';
import { Switch } from '../../ui/Form';
import { useClientPermissions } from './clientPermissions';
import { EditableSection } from './EditableSection';

interface CommunicationDraft {
  email_reminders: boolean;
  sms_reminders: boolean;
  portal_enabled: boolean;
  portal_messaging: boolean;
  portal_booking: boolean;
  portal_billing: boolean;
}

function OnOff({ label, on, note }: { label: string; on: boolean; note?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {on ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
      ) : (
        <Minus className="mt-0.5 h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
      )}
      <span className={on ? 'text-sage-900' : 'text-sage-500'}>
        {label}
        <span className="sr-only">: {on ? 'on' : 'off'}</span>
        {note && <span className="block text-xs text-amber-700">{note}</span>}
      </span>
    </li>
  );
}

const SMS_OPTED_OUT = 'Opted out via STOP. They can text START to opt back in.';

export function CommunicationSection({ client }: { client: ClientDetail }) {
  const config = usePublicConfig();
  const { editProfile } = useClientPermissions(client);
  return (
    <EditableSection<CommunicationDraft>
      title="Communication & portal"
      editable={editProfile}
      client={client}
      toDraft={(c) => ({
        email_reminders: c.email_reminders,
        sms_reminders: c.sms_reminders,
        portal_enabled: c.portal_enabled,
        portal_messaging: c.portal_messaging,
        portal_booking: c.portal_booking,
        portal_billing: c.portal_billing,
      })}
      toUpdate={(draft) => ({ update: draft })}
      view={
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-sage-500">Reminders</h3>
            <ul className="space-y-1.5">
              <OnOff label="Email reminders" on={client.email_reminders} />
              <OnOff
                label="Text reminders"
                on={client.sms_reminders && !client.sms_opted_out}
                note={client.sms_opted_out ? SMS_OPTED_OUT : undefined}
              />
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-sage-500">Client portal</h3>
            <ul className="space-y-1.5">
              <OnOff label="Portal access" on={client.portal_enabled} />
              <OnOff label="Secure messaging" on={client.portal_enabled && client.portal_messaging} />
              <OnOff label="Online appointment requests" on={client.portal_enabled && client.portal_booking} />
              <OnOff label="Billing and payments" on={client.portal_enabled && client.portal_billing} />
            </ul>
          </div>
        </div>
      }
    >
      {({ draft, set }) => (
        <>
          <Switch
            label="Email reminders"
            description={client.email ? 'Appointment reminders by email' : 'Add an email address to send reminders'}
            checked={draft.email_reminders}
            onChange={(checked) => set({ email_reminders: checked })}
          />
          <Switch
            label="Text reminders"
            description={
              client.sms_opted_out
                ? SMS_OPTED_OUT
                : !config.sms_enabled
                  ? "Text messaging isn't configured on this server, so texts won't be sent."
                  : 'Only with the client’s consent to receive texts'
            }
            checked={draft.sms_reminders}
            onChange={(checked) => set({ sms_reminders: checked })}
          />
          <div className="border-t border-sage-100 pt-4">
            <Switch
              label="Portal access"
              description="Turning this off signs the client and their contacts out of the portal right away."
              checked={draft.portal_enabled}
              onChange={(checked) => set({ portal_enabled: checked })}
            />
          </div>
          <div className="space-y-4 pl-4 sm:pl-6">
            <Switch
              label="Secure messaging"
              checked={draft.portal_messaging}
              disabled={!draft.portal_enabled}
              onChange={(checked) => set({ portal_messaging: checked })}
            />
            <Switch
              label="Online appointment requests"
              checked={draft.portal_booking}
              disabled={!draft.portal_enabled}
              onChange={(checked) => set({ portal_booking: checked })}
            />
            <Switch
              label="Billing and payments"
              description="Invoices, statements, superbills and online payment"
              checked={draft.portal_billing}
              disabled={!draft.portal_enabled}
              onChange={(checked) => set({ portal_billing: checked })}
            />
          </div>
          {client.portal_enabled && !draft.portal_enabled && (
            <Alert tone="warning">
              The client and any contacts with portal access will lose access and be signed out when you save.
            </Alert>
          )}
        </>
      )}
    </EditableSection>
  );
}
