import { CheckCircle2 } from 'lucide-react';
import type { InsuranceSettings } from '../../../api/insurance';
import { Card, CardBody, CardHeader } from '../../../ui/Card';
import { Alert, Badge } from '../../../ui/Display';

function EnvVar({ children }: { children: string }) {
  return <code className="rounded bg-sage-100 px-1 text-sage-800">{children}</code>;
}

/** Whether a clearinghouse is connected on the server, and how to connect one. */
export function ClearinghouseCard({ settings }: { settings: InsuranceSettings }) {
  const testMode = settings.clearinghouse_usage !== 'P';
  return (
    <Card>
      <CardHeader
        title="Clearinghouse"
        description="Send claims electronically, check eligibility, and receive acknowledgments and insurance payments automatically."
      />
      <CardBody className="space-y-3 text-sm">
        {settings.clearinghouse_enabled ? (
          <>
            <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">Connected to Stedi.</span>
                <Badge tone={testMode ? 'warning' : 'success'}>{testMode ? 'Test mode' : 'Production'}</Badge>
              </div>
            </div>
            {testMode && (
              <p className="text-sage-600">
                Claims are sent as test data and won&apos;t reach payers. When you&apos;re ready to bill for real, use a
                production API key and set <EnvVar>STEDI_USAGE=P</EnvVar> in the server&apos;s environment.
              </p>
            )}
          </>
        ) : (
          <Alert tone="info" title="No clearinghouse connected">
            <p>
              You can still bill insurance: download 837P files to upload to any clearinghouse, or print CMS-1500 forms.
              To submit claims and check eligibility from here, add a Stedi API key as <EnvVar>STEDI_API_KEY</EnvVar> in
              the server&apos;s environment (start with a test key and <EnvVar>STEDI_USAGE=T</EnvVar>), then restart the
              API and worker.
            </p>
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}
