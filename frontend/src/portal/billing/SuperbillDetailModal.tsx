import type { ReactNode } from 'react';
import { billingApi, type Superbill, type SuperbillProvider } from '../../api/billing';
import { formatMoney, formatPlainDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { Detail, PdfButton } from './components/BillingDisplay';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-sage-100 p-4">
      <h3 className="mb-3 text-sm font-semibold text-sage-900">{title}</h3>
      {children}
    </section>
  );
}

/** "Jordan Lee, LCSW". */
function providerName(provider: SuperbillProvider): string {
  return provider.credentials ? `${provider.name}, ${provider.credentials}` : provider.name;
}

/** An identifier row that says so when the practice hasn't filled it in. */
function IdDetail({ label, value }: { label: string; value: string }) {
  return <Detail label={label}>{value || <span className="text-sage-500">Not set</span>}</Detail>;
}

function ProviderDetails({ provider }: { provider: SuperbillProvider }) {
  return (
    <dl className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <Detail label="Name">{providerName(provider)}</Detail>
      </div>
      <IdDetail label="NPI" value={provider.npi} />
      <IdDetail label="Taxonomy" value={provider.taxonomy_code} />
      <div className="col-span-2">
        <IdDetail label="License" value={provider.license} />
      </div>
    </dl>
  );
}

/** Everything a superbill says, as frozen when it was created, with its PDF. */
export function SuperbillDetailModal({ superbill, onClose }: { superbill: Superbill; onClose: () => void }) {
  const { data } = superbill;
  const several = data.provider === null;
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={superbill.number}
      description={`${data.client.name} · ${formatPlainDate(superbill.period_start)} – ${formatPlainDate(superbill.period_end)}`}
      footer={
        <>
          <PdfButton download={() => billingApi.downloadSuperbillPdf(superbill.id)} label="Download PDF" />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Section title="Practice">
            <dl className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Detail label="Name">
                  {data.practice.name}
                  {data.practice.address_lines.map((line) => (
                    <span key={line} className="block text-sage-600">
                      {line}
                    </span>
                  ))}
                  {data.practice.phone && <span className="block text-sage-600">{data.practice.phone}</span>}
                </Detail>
              </div>
              <IdDetail label={`Tax ID (${data.practice.tax_id_type})`} value={data.practice.tax_id} />
              <IdDetail label="Group NPI" value={data.practice.npi} />
              <IdDetail label="Taxonomy" value={data.practice.taxonomy_code} />
              <Detail label="Billing provider">
                {data.practice.billing_provider === 'organization' ? 'The practice (group NPI)' : 'Each clinician (own NPI)'}
              </Detail>
            </dl>
          </Section>
          <Section title={several ? 'Providers' : 'Provider'}>
            {data.provider ? (
              <ProviderDetails provider={data.provider} />
            ) : (
              <p className="text-sm text-sage-600">
                Several clinicians provided these services, so each service below lists its provider.
              </p>
            )}
          </Section>
          <Section title="Client">
            <dl className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Detail label="Name">
                  {data.client.name}
                  {data.client.address_lines.map((line) => (
                    <span key={line} className="block text-sage-600">
                      {line}
                    </span>
                  ))}
                </Detail>
              </div>
              <Detail label="Date of birth">
                {data.client.date_of_birth ? formatPlainDate(data.client.date_of_birth) : <span className="text-sage-500">Not set</span>}
              </Detail>
              <IdDetail label="Phone" value={data.client.phone} />
            </dl>
          </Section>
          <Section title="Insurance">
            {data.insurance ? (
              <dl className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Detail label="Payer">
                    {data.insurance.payer_name}
                    {data.insurance.plan_name && <span className="block text-sage-600">{data.insurance.plan_name}</span>}
                  </Detail>
                </div>
                <IdDetail label="Payer ID" value={data.insurance.payer_id} />
                <IdDetail label="Member ID" value={data.insurance.member_id} />
                <IdDetail label="Group number" value={data.insurance.group_number} />
                <Detail label="Subscriber">
                  {data.insurance.subscriber_name || <span className="text-sage-500">Not set</span>}
                  <span className="block text-sage-600">
                    {data.insurance.subscriber_relationship}
                    {data.insurance.subscriber_dob && ` · born ${formatPlainDate(data.insurance.subscriber_dob)}`}
                  </span>
                </Detail>
              </dl>
            ) : (
              <p className="text-sm text-sage-600">No insurance policy was in effect for this period.</p>
            )}
          </Section>
        </div>

        <Section title="Diagnoses">
          {data.diagnosis_codes.length === 0 ? (
            <p className="text-sm text-sage-600">No diagnosis codes were on the client's chart.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {data.diagnosis_codes.map((diagnosis) => (
                <li key={diagnosis.code}>
                  <span className="font-medium text-sage-900">{diagnosis.code}</span>
                  {diagnosis.description && <span className="text-sage-700"> · {diagnosis.description}</span>}
                </li>
              ))}
            </ol>
          )}
        </Section>

        <section aria-label="Services">
          <h3 className="mb-2 text-sm font-semibold text-sage-900">Services</h3>
          <div className="overflow-x-auto rounded-lg border border-sage-100">
            <table className="min-w-full divide-y divide-sage-100 text-sm">
              <thead className="bg-sage-50 text-left text-xs font-semibold uppercase tracking-wide text-sage-500">
                <tr>
                  <th scope="col" className="px-3 py-2">Date</th>
                  <th scope="col" className="px-3 py-2">CPT</th>
                  <th scope="col" className="px-3 py-2">Description</th>
                  <th scope="col" className="px-3 py-2">POS</th>
                  <th scope="col" className="px-3 py-2 text-right">Units</th>
                  {several && (
                    <th scope="col" className="px-3 py-2">Provider</th>
                  )}
                  <th scope="col" className="px-3 py-2 text-right">Fee</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sage-100">
                {data.lines.map((line, index) => (
                  <tr key={`${line.date}-${index}`}>
                    <td className="whitespace-nowrap px-3 py-2 text-sage-800">{formatPlainDate(line.date)}</td>
                    <td className="px-3 py-2 text-sage-800">{line.cpt || '—'}</td>
                    <td className="px-3 py-2 text-sage-800">{line.description}</td>
                    <td className="px-3 py-2 text-sage-800">{line.place_of_service}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sage-800">{line.units}</td>
                    {several && (
                      <td className="px-3 py-2 text-sage-800">
                        {providerName(line.provider)}
                        {line.provider.npi && <span className="block text-xs text-sage-500">NPI {line.provider.npi}</span>}
                      </td>
                    )}
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-sage-900">{formatMoney(line.fee_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          <Section title="Payments in this period">
            {data.payments.length === 0 ? (
              <p className="text-sm text-sage-600">No payments were received in this period.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.payments.map((payment, index) => (
                  <li key={`${payment.date}-${index}`} className="flex justify-between gap-3">
                    <span className="text-sage-700">
                      {formatPlainDate(payment.date)} · {payment.method}
                    </span>
                    <span className="tabular-nums text-sage-900">{formatMoney(payment.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Totals">
            <dl className="grid grid-cols-2 gap-3">
              <Detail label="Total charged">
                <span className="tabular-nums">{formatMoney(data.total_cents)}</span>
              </Detail>
              <Detail label="Paid">
                <span className="tabular-nums">{formatMoney(data.paid_cents)}</span>
              </Detail>
            </dl>
          </Section>
        </div>
      </div>
    </Modal>
  );
}
