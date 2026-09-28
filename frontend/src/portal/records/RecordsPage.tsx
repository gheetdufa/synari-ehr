import { useSearchParams } from 'react-router-dom';
import { PageHeader, Tabs } from '../../ui/Display';
import { idParam } from './recordHelpers';
import { AmendmentList, RecordRequestList } from './RequestLists';

type RecordsTab = 'copies' | 'amendments';

const TABS: { id: RecordsTab; label: string }[] = [
  { id: 'copies', label: 'Copies of records' },
  { id: 'amendments', label: 'Amendments' },
];

/**
 * /portal/records — clients' requests under their privacy rights, for the clients this person
 * can see clinically: copies of their record (due in 30 days) and amendments (due in 60 days).
 *
 * Notifications link here with `?request=<id>` or `?amendment=<id>`, which opens the right tab
 * and marks that request.
 */
export default function RecordsPage() {
  const [params, setParams] = useSearchParams();
  const requestId = idParam(params.get('request'));
  const amendmentId = idParam(params.get('amendment'));
  const tab: RecordsTab =
    amendmentId !== undefined || (requestId === undefined && params.get('tab') === 'amendments')
      ? 'amendments'
      : 'copies';
  const select = (next: RecordsTab) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.delete('request');
        updated.delete('amendment');
        if (next === 'copies') updated.delete('tab');
        else updated.set('tab', next);
        return updated;
      },
      { replace: true },
    );
  return (
    <div>
      <PageHeader
        title="Record requests"
        description="Requests from clients to get a copy of their record or to amend it. Deadlines count from the day the request arrived."
      />
      <div className="mb-6">
        <Tabs tabs={TABS} active={tab} onChange={select} />
      </div>
      <div role="tabpanel" aria-label={TABS.find((item) => item.id === tab)?.label}>
        {tab === 'copies' ? (
          <RecordRequestList key={requestId ?? 'queue'} highlightId={requestId} />
        ) : (
          <AmendmentList key={amendmentId ?? 'queue'} highlightId={amendmentId} />
        )}
      </div>
    </div>
  );
}
