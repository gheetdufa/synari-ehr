import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { practiceApi, practiceKeys, type Service } from '../../../api/practice';
import { teamApi, teamKeys, type ClinicianServiceRate, type TeamMember } from '../../../api/team';
import { Button } from '../../../ui/Button';
import { Alert, Badge, ErrorState } from '../../../ui/Display';
import { Checkbox, Input } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { practiceRateHint, rateRows, ratesInput, type RateRow } from './teamRules';

function RatesForm({
  member,
  services,
  rates,
  onSave,
}: {
  member: TeamMember;
  services: Service[];
  rates: ClinicianServiceRate[];
  onSave: (rates: ClinicianServiceRate[]) => void;
}) {
  const [rows, setRows] = useState<RateRow[]>(() => rateRows(services, rates));
  const [errors, setErrors] = useState<Record<number, string>>({});
  const update = (serviceId: number, patch: Partial<RateRow>) =>
    setRows((current) => current.map((row) => (row.service.id === serviceId ? { ...row, ...patch } : row)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { rates: input, errors: found } = ratesInput(rows);
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(input);
  };

  return (
    <form id="rates-form" onSubmit={submit} noValidate>
      <ul className="divide-y divide-sage-100 rounded-lg border border-sage-100">
        {rows.map(({ service, offered, rate }) => {
          const errorId = `rate-error-${service.id}`;
          return (
            <li key={service.id} className="grid gap-2 px-3 py-3 sm:grid-cols-[1fr_10rem] sm:items-center">
              <Checkbox
                label={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-sage-600">{service.code}</span> {service.description}
                    {!service.is_active && <Badge>Inactive</Badge>}
                  </span>
                }
                description={offered ? 'Offers this service' : "Doesn't offer this service"}
                checked={offered}
                onChange={(event) => update(service.id, { offered: event.target.checked })}
              />
              <div>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-sage-500">$</span>
                  <Input
                    aria-label={`${member.first_name}'s rate for ${service.code}`}
                    aria-invalid={errors[service.id] ? true : undefined}
                    aria-describedby={errors[service.id] ? errorId : undefined}
                    inputMode="decimal"
                    className="pl-7"
                    placeholder={(service.rate_cents / 100).toFixed(2)}
                    value={rate}
                    disabled={!offered}
                    onChange={(event) => update(service.id, { rate: event.target.value })}
                  />
                </div>
                {errors[service.id] ? (
                  <p id={errorId} className="mt-1 text-sm text-red-600">
                    {errors[service.id]}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-sage-500">{rate.trim() ? 'Own rate' : practiceRateHint(service)}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </form>
  );
}

/** Which practice services a clinician offers, and their own rate for each (blank = practice rate). */
export function ClinicianRatesModal({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const services = useQuery({ queryKey: practiceKeys.services, queryFn: practiceApi.services });
  const rates = useQuery({ queryKey: teamKeys.services(member.id), queryFn: () => teamApi.services(member.id) });
  const [formError, setFormError] = useState<string | null>(null);
  const error = services.error ?? rates.error;

  const save = useMutation({
    mutationFn: (input: ClinicianServiceRate[]) => teamApi.setServices(member.id, input),
    onMutate: () => setFormError(null),
    onSuccess: (saved) => {
      queryClient.setQueryData(teamKeys.services(member.id), saved);
      toast.success(`Services and rates saved for ${member.first_name}`);
      onClose();
    },
    onError: (err) => setFormError(err.message),
  });
  const close = () => !save.isPending && onClose();

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={`Services & rates for ${member.first_name} ${member.last_name}`}
      description="Leave a rate blank to use the practice's standard rate. Existing appointments keep their fee."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="rates-form" loading={save.isPending} disabled={!services.data || !rates.data}>
            Save services and rates
          </Button>
        </>
      }
    >
      {formError && (
        <div className="mb-3">
          <Alert tone="danger">{formError}</Alert>
        </div>
      )}
      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void services.refetch();
            void rates.refetch();
          }}
        />
      ) : services.data && rates.data ? (
        <RatesForm member={member} services={services.data} rates={rates.data} onSave={(input) => save.mutate(input)} />
      ) : (
        <SectionSpinner />
      )}
    </Modal>
  );
}
