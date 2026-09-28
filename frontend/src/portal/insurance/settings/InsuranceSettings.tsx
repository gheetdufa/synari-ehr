import { Card } from '../../../ui/Card';
import { ErrorState } from '../../../ui/Display';
import { SectionSpinner } from '../../../ui/Spinner';
import { useInsuranceSettings } from '../hooks';
import { ClaimOptionsForm } from './ClaimOptionsForm';
import { ClearinghouseCard } from './ClearinghouseCard';
import { PayersCard } from './PayersCard';

/** Settings > Insurance: the clearinghouse connection, claim options and the payer list. */
export function InsuranceSettings() {
  const settings = useInsuranceSettings();
  if (settings.isPending) return <SectionSpinner />;
  if (settings.isError) {
    return (
      <Card>
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      <ClearinghouseCard settings={settings.data} />
      <ClaimOptionsForm settings={settings.data} />
      <PayersCard clearinghouseEnabled={settings.data.clearinghouse_enabled} />
    </div>
  );
}
