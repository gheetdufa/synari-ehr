import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import { portalRecordKeys, portalRecordsApi, type PortalDisclosure } from '../../api/portalRecords';
import { formatPlainDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';

function DisclosureRow({ disclosure }: { disclosure: PortalDisclosure }) {
  return (
    <li className="px-5 py-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-medium text-sage-900">{disclosure.recipient_name}</p>
        <p className="text-sage-600">{formatPlainDate(disclosure.disclosed_on)}</p>
      </div>
      {disclosure.recipient_address && (
        <p className="mt-0.5 whitespace-pre-line break-words text-sage-600">{disclosure.recipient_address}</p>
      )}
      <dl className="mt-2 grid gap-1 sm:grid-cols-[8rem_1fr]">
        <dt className="text-sage-500">Purpose</dt>
        <dd className="break-words text-sage-800">{disclosure.purpose}</dd>
        <dt className="text-sage-500">What was shared</dt>
        <dd className="whitespace-pre-line break-words text-sage-800">{disclosure.description}</dd>
        {disclosure.legal_basis && (
          <>
            <dt className="text-sage-500">Basis</dt>
            <dd className="break-words text-sage-800">{disclosure.legal_basis}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

/** The accounting of disclosures: who the practice shared the client's information with outside
 * treatment, payment and operations over the last six years. */
export function DisclosuresSection() {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const accounting = useQuery({ queryKey: portalRecordKeys.disclosures, queryFn: portalRecordsApi.disclosures });

  const download = async () => {
    setDownloading(true);
    try {
      await portalRecordsApi.downloadDisclosuresPdf();
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(false);
    }
  };

  const disclosures = accounting.data?.disclosures ?? [];
  return (
    <Card>
      <CardHeader
        title="Who my information was shared with"
        description="An accounting of disclosures: times the practice shared your information for reasons other than your treatment, payment for your care or its day-to-day operations, over the last six years."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Download className="h-4 w-4" />}
            loading={downloading}
            onClick={() => void download()}
          >
            Download PDF
          </Button>
        }
      />
      {accounting.isPending && <SectionSpinner />}
      {accounting.error && <ErrorState error={accounting.error} onRetry={() => void accounting.refetch()} />}
      {accounting.data && disclosures.length === 0 && (
        <EmptyState
          icon={<ShieldCheck />}
          title="Nothing to report"
          description="The practice hasn’t shared your information outside your treatment, payment and its normal operations in the last six years."
        />
      )}
      {disclosures.length > 0 && (
        <ul className="divide-y divide-sage-100" aria-label="Disclosures">
          {disclosures.map((disclosure) => (
            <DisclosureRow key={disclosure.id} disclosure={disclosure} />
          ))}
        </ul>
      )}
    </Card>
  );
}
