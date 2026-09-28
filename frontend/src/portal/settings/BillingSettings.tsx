import { CheckCircle2 } from 'lucide-react';
import type { PracticeSettings } from '../../api/practice';
import { API_URL } from '../../lib/config';
import { useCan } from '../../auth/StaffAuth';
import { usePublicConfig } from '../../lib/usePublicConfig';
import { Alert } from '../../ui/Display';
import { Field, Select, Switch } from '../../ui/Form';
import { numberOptions } from './settingsHelpers';
import { SettingsForm, usePracticeSettingsForm } from './SettingsForm';

const KEYS = ['bill_missed_appointments', 'invoice_due_days', 'autopay_enabled', 'gfe_enabled'] as const;

function dueLabel(days: number): string {
  if (days === 0) return 'Due on receipt';
  return `Due in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Invoicing rules, AutoPay, and whether online card payments are available. */
export function BillingSettings({ settings }: { settings: PracticeSettings }) {
  const config = usePublicConfig();
  const canEdit = useCan('manage_practice');
  const form = usePracticeSettingsForm(settings, KEYS, 'Billing settings saved');
  const { draft, set, errors } = form;

  return (
    <SettingsForm
      title="Billing"
      description="Sessions are invoiced automatically the day after they happen, just after midnight in the practice's time zone, with one invoice per client and day. Finished sessions nobody updates are marked attended."
      dirty={form.dirty}
      saving={form.saving}
      readOnly={!canEdit}
      onSubmit={() => form.submit()}
      onDiscard={form.discard}
    >
      {config.payments_enabled ? (
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <p>
            <span className="font-semibold">Online card payments are on.</span> Clients can pay invoices and save cards
            in the portal through Stripe.
          </p>
        </div>
      ) : (
        <Alert tone="warning" title="Online card payments aren't set up">
          <p>
            You can still record cash, check and external card payments. To accept cards in the client portal, add{' '}
            <code className="rounded bg-amber-100 px-1">STRIPE_SECRET_KEY</code> and{' '}
            <code className="rounded bg-amber-100 px-1">STRIPE_WEBHOOK_SECRET</code> to the API&apos;s environment, and
            point a Stripe webhook at <code className="break-all rounded bg-amber-100 px-1">{API_URL}/webhooks/stripe</code>.
          </p>
        </Alert>
      )}
      <Switch
        label="Bill missed appointments"
        description="Charge the full fee for no-shows and late cancellations. Canceled appointments are never billed."
        checked={draft.bill_missed_appointments}
        onChange={(checked) => set({ bill_missed_appointments: checked })}
      />
      <Field label="Invoice payment terms" error={errors.invoice_due_days} className="sm:max-w-xs">
        {(props) => (
          <Select {...props} value={draft.invoice_due_days} onChange={(e) => set({ invoice_due_days: Number(e.target.value) })}>
            {numberOptions([0, 7, 14, 15, 30, 45, 60, 90], settings.invoice_due_days).map((days) => (
              <option key={days} value={days}>
                {dueLabel(days)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="border-t border-sage-100 pt-5">
        <Switch
          label="Allow AutoPay"
          description={
            config.payments_enabled
              ? "Lets you turn on AutoPay for individual clients with a saved card. Their card is charged for the full balance once a day, after that day's invoices are created."
              : 'Requires online card payments.'
          }
          checked={draft.autopay_enabled}
          disabled={!config.payments_enabled && !draft.autopay_enabled}
          onChange={(checked) => set({ autopay_enabled: checked })}
        />
      </div>
      <div className="border-t border-sage-100 pt-5">
        <Switch
          label="Good faith estimates for self-pay clients"
          description="Track the estimates the No Surprises Act requires for self-pay and uninsured clients: drafts start with a due date when care is scheduled, clients can ask for one in the portal, and invoices warn when charges near an estimate. The client portal and booking page show the right-to-an-estimate notice."
          checked={draft.gfe_enabled}
          onChange={(checked) => set({ gfe_enabled: checked })}
        />
      </div>
    </SettingsForm>
  );
}
