import { useQuery } from '@tanstack/react-query';
import type { BillingType, ClientDetail } from '../../api/clients';
import { practiceApi, practiceKeys, type Service } from '../../api/practice';
import { formatMoney, parseMoneyToCents } from '../../lib/format';
import { Field, Input, Select } from '../../ui/Form';
import { BILLING_TYPE_LABELS } from './clientHelpers';
import { useClientPermissions } from './clientPermissions';
import { DetailList, EditableSection, type SectionUpdate } from './EditableSection';
import { centsToInput } from './formUtils';

interface BillingDraft {
  billing_type: BillingType;
  default_service_id: string;
  rate: string;
}

export function billingUpdate(draft: BillingDraft): SectionUpdate {
  const errors: Record<string, string> = {};
  let rate: number | null = null;
  if (draft.rate.trim()) {
    rate = parseMoneyToCents(draft.rate);
    if (rate === null) errors.rate_override_cents = 'Enter an amount like 120 or 120.50';
  }
  return {
    errors,
    update: {
      billing_type: draft.billing_type,
      default_service_id: draft.default_service_id ? Number(draft.default_service_id) : null,
      rate_override_cents: rate,
    },
  };
}

function serviceLabel(service: Service): string {
  return `${service.code} · ${service.description}`;
}

/** Billing type, default service and custom rate; only staff with billing access can change them. */
export function BillingSection({ client }: { client: ClientDetail }) {
  const { billing } = useClientPermissions(client);
  const services = useQuery({ queryKey: practiceKeys.services, queryFn: practiceApi.services });
  const all = services.data ?? [];
  const selectable = all.filter((service) => service.is_active || service.id === client.default_service_id);
  const defaultService = all.find((service) => service.id === client.default_service_id);
  const practiceDefault = all.find((service) => service.is_default);
  const effective = defaultService ?? practiceDefault;

  return (
    <EditableSection<BillingDraft>
      title="Billing"
      editable={billing}
      client={client}
      toDraft={(c) => ({
        billing_type: c.billing_type,
        default_service_id: c.default_service_id ? String(c.default_service_id) : '',
        rate: centsToInput(c.rate_override_cents),
      })}
      toUpdate={billingUpdate}
      view={
        <DetailList
          items={[
            { label: 'Billing type', value: BILLING_TYPE_LABELS[client.billing_type] },
            {
              label: 'Default service',
              value: defaultService
                ? serviceLabel(defaultService)
                : practiceDefault
                  ? `Practice default (${serviceLabel(practiceDefault)})`
                  : '',
            },
            {
              label: 'Rate',
              value:
                client.rate_override_cents !== null
                  ? `${formatMoney(client.rate_override_cents)} (custom rate)`
                  : effective
                    ? `${formatMoney(effective.rate_cents)} (service rate)`
                    : '',
            },
          ]}
        />
      }
    >
      {({ draft, set, errors }) => (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Billing type" error={errors.billing_type}>
            {(props) => (
              <Select {...props} value={draft.billing_type} onChange={(e) => set({ billing_type: e.target.value as BillingType })}>
                {Object.entries(BILLING_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Default service"
            error={errors.default_service_id ?? (services.isError ? "Couldn't load services" : undefined)}
          >
            {(props) => (
              <Select
                {...props}
                value={draft.default_service_id}
                disabled={services.isPending}
                onChange={(e) => set({ default_service_id: e.target.value })}
              >
                <option value="">Practice default{practiceDefault ? ` (${practiceDefault.code})` : ''}</option>
                {selectable.map((service) => (
                  <option key={service.id} value={service.id}>
                    {serviceLabel(service)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Custom rate" hint="Leave blank to use the service rate" error={errors.rate_override_cents}>
            {(props) => (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-sage-500">$</span>
                <Input
                  {...props}
                  inputMode="decimal"
                  className="pl-7"
                  placeholder="0.00"
                  value={draft.rate}
                  onChange={(e) => set({ rate: e.target.value })}
                />
              </div>
            )}
          </Field>
        </div>
      )}
    </EditableSection>
  );
}
