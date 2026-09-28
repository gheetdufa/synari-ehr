import type { ClaimDetail } from '../../../api/claims';
import { formatMoney, formatPlainDate } from '../../../lib/format';
import { Card, CardBody, CardHeader } from '../../../ui/Card';
import { Table, Td, Th } from '../../../ui/Display';
import { formatDiagnosisCode, pointerLetter } from '../labels';

function money(cents: number | null): string {
  return cents === null ? '—' : formatMoney(cents);
}

/** A claim the payer has (or a void one): diagnoses, and each line with what was paid. */
export function ClaimReadOnly({ claim }: { claim: ClaimDetail }) {
  return (
    <Card>
      <CardHeader title="Diagnoses and service lines" />
      <CardBody>
        {claim.diagnoses.length === 0 ? (
          <p className="text-sm text-sage-600">No diagnoses on this claim.</p>
        ) : (
          <ol className="grid gap-1 text-sm sm:grid-cols-2">
            {claim.diagnoses.map((diagnosis, index) => (
              <li key={diagnosis.code} className="flex gap-2">
                <span className="font-semibold text-primary-800">{pointerLetter(index + 1)}.</span>
                <span>
                  <span className="font-medium text-sage-900">{formatDiagnosisCode(diagnosis.code)}</span>
                  {diagnosis.description && <span className="text-sage-600"> {diagnosis.description}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
      <Table>
        <thead className="bg-sage-50/60">
          <tr>
            <Th>Date</Th>
            <Th>Service</Th>
            <Th className="hidden sm:table-cell">Pointers</Th>
            <Th className="text-right">Billed</Th>
            <Th className="hidden text-right md:table-cell">Allowed</Th>
            <Th className="text-right">Paid</Th>
            <Th className="hidden text-right md:table-cell">Adjusted</Th>
            <Th className="text-right">Client owes</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sage-100">
          {claim.lines.map((line) => (
            <tr key={line.id}>
              <Td className="whitespace-nowrap">{formatPlainDate(line.service_date)}</Td>
              <Td>
                <span className="font-medium">{line.procedure_code}</span>
                {line.modifiers.length > 0 && <span className="text-sage-600"> {line.modifiers.join(' ')}</span>}
                <span className="block text-xs text-sage-500">
                  {line.units} {line.units === 1 ? 'unit' : 'units'}
                  {line.place_of_service && ` · POS ${line.place_of_service}`}
                </span>
              </Td>
              <Td className="hidden sm:table-cell">{line.diagnosis_pointers.map(pointerLetter).join(', ')}</Td>
              <Td className="text-right tabular-nums">{formatMoney(line.charge_cents)}</Td>
              <Td className="hidden text-right tabular-nums md:table-cell">{money(line.allowed_cents)}</Td>
              <Td className="text-right tabular-nums">{formatMoney(line.paid_cents)}</Td>
              <Td className="hidden text-right tabular-nums md:table-cell">{formatMoney(line.adjustment_cents)}</Td>
              <Td className="text-right tabular-nums">{formatMoney(line.patient_responsibility_cents)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
