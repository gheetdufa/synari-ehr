import { useQuery } from '@tanstack/react-query';
import { FileArchive, FileSpreadsheet } from 'lucide-react';
import { importKeys, importsApi, type ImportFileKind } from '../../../api/imports';
import { Card, CardBody, CardHeader } from '../../../ui/Card';
import { Badge, ErrorState } from '../../../ui/Display';
import { SectionSpinner } from '../../../ui/Spinner';

/** How much each file adds to the import. */
const IMPORTANCE: Record<ImportFileKind, { label: string; tone: 'primary' | 'neutral' }> = {
  export_zip: { label: 'Recommended', tone: 'primary' },
  client_details: { label: 'Recommended', tone: 'primary' },
  client_demographics: { label: 'Recommended', tone: 'primary' },
  appointment_status: { label: 'Recommended', tone: 'primary' },
  attendance: { label: 'Optional', tone: 'neutral' },
  outstanding_balances: { label: 'Optional', tone: 'neutral' },
  client_list: { label: 'Optional', tone: 'neutral' },
};

/** Where to find each file in SimplePractice, beyond the server's short description. */
const WHERE: Record<ImportFileKind, string> = {
  export_zip:
    'Settings > Practice > Data export > Start export, and choose "Complete". The zip is password protected by default; the download link and password expire after a week.',
  client_details:
    'Analytics > Reports > Client details. Include Active, Inactive and Prospective clients and turn on "Include Contacts". Download as CSV or XLSX.',
  client_demographics: 'Analytics > Reports > Client demographics. Download as CSV or XLSX.',
  appointment_status:
    'Analytics > Reports > Appointment status, for all dates. Turn on "Include Insurance" and "Include Documentation". Download as CSV or XLSX.',
  attendance: 'Analytics > Reports > Attendance, for all dates. Download as CSV or XLSX.',
  outstanding_balances: 'Analytics > Reports > Outstanding balances. Download as CSV or XLSX.',
  client_list:
    'Only SimplePractice support can provide it (with the account owner\'s consent). It adds insurance details and diagnoses.',
};

/** What SimplePractice's exports can't carry over, stated plainly before anyone starts. */
export function ImportLimits() {
  return (
    <Card>
      <CardHeader title="What to expect" description="SimplePractice's exports have some gaps. Here's how Synari handles them." />
      <CardBody>
        <ul className="list-disc space-y-2 pl-5 text-sm text-sage-700">
          <li>
            SimplePractice reports have no appointment times or lengths. Imported sessions start at 9:00 AM in the
            clinician's time zone (later on days with several sessions) and last according to their CPT code:
            90832 and 90833 30 minutes; 90834 and 90836 45; 90837, 90838, 90791, 90792, 90839, 90849 and 90853 60;
            anything else 50. A time or duration column in your report is used instead.
          </li>
          <li>
            Notes, treatment plans, assessments, invoices, statements and superbills arrive as PDF documents on each
            client's record, not as editable notes or invoices.
          </li>
          <li>Future appointments aren't in the exports. Recreate upcoming sessions in Synari after importing.</li>
          <li>
            Imported sessions are history only: they're never invoiced, sent on claims, reminded, synced to
            calendars or counted as missing notes.
          </li>
          <li>Outstanding balances become one opening-balance invoice per client. No emails are sent about them.</li>
          <li>Psychotherapy Notes are visible only to the client's primary clinician and are never shared or exported.</li>
          <li>Nothing is emailed to clients during an import.</li>
        </ul>
      </CardBody>
    </Card>
  );
}

/** Which exports to download from SimplePractice and where to find them. */
export function ImportGuide() {
  const kinds = useQuery({ queryKey: importKeys.kinds, queryFn: importsApi.kinds, staleTime: Infinity });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Bring your practice over from SimplePractice"
          description="Download these files from SimplePractice, upload them here, review what we found, then import. Nothing changes in Synari until you start the import."
        />
        {kinds.isPending && <SectionSpinner />}
        {kinds.error && <ErrorState error={kinds.error} onRetry={() => void kinds.refetch()} />}
        {kinds.data && (
          <ul className="divide-y divide-sage-100">
            {kinds.data.map((info) => {
              const Icon = info.kind === 'export_zip' ? FileArchive : FileSpreadsheet;
              const importance = IMPORTANCE[info.kind];
              return (
                <li key={info.kind} className="flex gap-3 px-5 py-4">
                  <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary-700" />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-sage-900">{info.label}</h3>
                      {importance && <Badge tone={importance.tone}>{importance.label}</Badge>}
                      <span className="text-xs text-sage-500">{info.extensions.join(', ')}</span>
                    </div>
                    <p className="text-sm text-sage-700">{info.description}</p>
                    {WHERE[info.kind] && <p className="text-sm text-sage-500">Where: {WHERE[info.kind]}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <ImportLimits />
    </div>
  );
}
