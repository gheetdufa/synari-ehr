import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Archive,
  Bell,
  Building2,
  CalendarCog,
  Clock,
  CreditCard,
  FileText,
  History,
  Import,
  MapPin,
  MessageSquare,
  Shield,
  ShieldCheck,
  Tag,
  User,
  Users,
  Video,
} from 'lucide-react';
import { meApi, meKeys } from '../../api/me';
import { practiceApi, practiceKeys } from '../../api/practice';
import { useSession } from '../../auth/StaffAuth';
import { InsuranceSettings } from '../insurance/settings/InsuranceSettings';
import { Card } from '../../ui/Card';
import { ErrorState, PageHeader, Tabs } from '../../ui/Display';
import { ConfirmDialog } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { ActivitySettings } from './ActivitySettings';
import { AvailabilitySettings } from './AvailabilitySettings';
import { CalendarConnectionsCard } from './CalendarConnectionsCard';
import { CalendarSyncCard } from './CalendarSyncCard';
import { BillingSettings } from './BillingSettings';
import { BookingSettings } from './BookingSettings';
import { DocumentationSettings } from './DocumentationSettings';
import { ImportSettings } from './import/ImportSettings';
import { LocationsSettings } from './locations/LocationsSettings';
import { MessagingSettings } from './MessagingSettings';
import { NotificationSettings } from './NotificationSettings';
import { PracticeDetailsSettings } from './PracticeDetailsSettings';
import { ProfileSettings } from './ProfileSettings';
import { RecordsSettings } from './RecordsSettings';
import { SecuritySettings } from './SecuritySettings';
import { ServicesSettings } from './ServicesSettings';
import { SETTINGS_TAB_LABELS, settingsTabFrom, settingsTabsFor, type SettingsTab } from './settingsTabs';
import { TeamSettings } from './team/TeamSettings';
import { TelehealthSettings } from './TelehealthSettings';
import { SettingsDirtyContext } from './useDraft';
import { WelcomeChecklist } from './WelcomeChecklist';

const TAB_ICONS: Record<SettingsTab, typeof User> = {
  profile: User,
  practice: Building2,
  team: Users,
  locations: MapPin,
  booking: CalendarCog,
  availability: Clock,
  services: Tag,
  notifications: Bell,
  messaging: MessageSquare,
  telehealth: Video,
  billing: CreditCard,
  insurance: ShieldCheck,
  documentation: FileText,
  security: Shield,
  records: Archive,
  activity: History,
  import: Import,
};

function VerticalTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: SettingsTab[];
  active: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
}) {
  return (
    <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" className="sticky top-24 space-y-0.5">
      {tabs.map((tab) => {
        const Icon = TAB_ICONS[tab];
        const selected = tab === active;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(tab)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
              selected ? 'bg-white text-primary-800 shadow-sm ring-1 ring-sage-100' : 'text-sage-600 hover:bg-white/70 hover:text-sage-900'
            }`}
          >
            <Icon className={`h-4 w-4 shrink-0 ${selected ? 'text-primary-600' : 'text-sage-400'}`} aria-hidden="true" />
            {SETTINGS_TAB_LABELS[tab]}
          </button>
        );
      })}
    </div>
  );
}

/** Renders `children` with a query's data, or its loading or error state. */
function Loaded<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <SectionSpinner />;
  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }
  return <>{children(query.data)}</>;
}

/**
 * Settings: your own profile and preferences, plus practice-wide settings (read-only without
 * `manage_practice`). Tabs are synced to `?tab=`, with an unsaved-changes guard between tabs.
 */
export default function SettingsPage() {
  const session = useSession();
  const tabs = settingsTabsFor(session);
  const [params, setParams] = useSearchParams();
  const tab = settingsTabFrom(params.get('tab'), tabs);
  const welcome = params.get('welcome') === '1';
  const settings = useQuery({ queryKey: practiceKeys.settings, queryFn: practiceApi.settings });
  const preferences = useQuery({ queryKey: meKeys.preferences, queryFn: meApi.preferences });
  const [dirtyForms, setDirtyForms] = useState<ReadonlySet<string>>(new Set());
  const [pendingTab, setPendingTab] = useState<SettingsTab | null>(null);
  const dirty = dirtyForms.size > 0;

  const report = useCallback((formId: string, isDirty: boolean) => {
    setDirtyForms((current) => {
      if (current.has(formId) === isDirty) return current;
      const next = new Set(current);
      if (isDirty) next.add(formId);
      else next.delete(formId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const updateParams = (change: (next: URLSearchParams) => void) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        change(next);
        return next;
      },
      { replace: true },
    );

  const goTo = (next: SettingsTab) => updateParams((search) => search.set('tab', next));
  const select = (next: SettingsTab) => {
    if (next === tab) return;
    if (dirty) setPendingTab(next);
    else goTo(next);
  };

  const content: Record<SettingsTab, () => ReactNode> = {
    profile: () => <ProfileSettings />,
    practice: () => <PracticeDetailsSettings />,
    team: () => <TeamSettings />,
    locations: () => <LocationsSettings />,
    booking: () => <Loaded query={settings}>{(loaded) => <BookingSettings settings={loaded} />}</Loaded>,
    availability: () => (
      <div className="space-y-6">
        <AvailabilitySettings />
        <CalendarConnectionsCard />
        {session.staff.is_clinician && <CalendarSyncCard />}
      </div>
    ),
    services: () => <ServicesSettings />,
    notifications: () => (
      <Loaded query={settings}>
        {(loaded) => (
          <Loaded query={preferences}>
            {(mine) => <NotificationSettings settings={loaded} preferences={mine} />}
          </Loaded>
        )}
      </Loaded>
    ),
    messaging: () => (
      <Loaded query={settings}>
        {(loaded) => (
          <Loaded query={preferences}>{(mine) => <MessagingSettings settings={loaded} preferences={mine} />}</Loaded>
        )}
      </Loaded>
    ),
    telehealth: () => <Loaded query={settings}>{(loaded) => <TelehealthSettings settings={loaded} />}</Loaded>,
    billing: () => <Loaded query={settings}>{(loaded) => <BillingSettings settings={loaded} />}</Loaded>,
    insurance: () => <InsuranceSettings />,
    documentation: () => (
      <Loaded query={preferences}>{(mine) => <DocumentationSettings preferences={mine} />}</Loaded>
    ),
    security: () => <SecuritySettings />,
    records: () => <Loaded query={settings}>{(loaded) => <RecordsSettings settings={loaded} />}</Loaded>,
    activity: () => <ActivitySettings />,
    import: () => <ImportSettings />,
  };

  return (
    <SettingsDirtyContext.Provider value={report}>
      <PageHeader title="Settings" description={`Your profile and preferences, and ${session.practice.name}'s settings.`} />
      {welcome && (
        <WelcomeChecklist
          settings={settings.data}
          onSelectTab={select}
          onDismiss={() => updateParams((search) => search.delete('welcome'))}
        />
      )}
      <div className="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
        <nav className="hidden lg:block" aria-label="Settings">
          <VerticalTabs tabs={tabs} active={tab} onSelect={select} />
        </nav>
        <div className="mb-6 lg:hidden">
          <Tabs
            tabs={tabs.map((id) => ({ id, label: SETTINGS_TAB_LABELS[id] }))}
            active={tab}
            onChange={select}
          />
        </div>
        <div role="tabpanel" aria-label={SETTINGS_TAB_LABELS[tab]} className="min-w-0">
          {content[tab]()}
        </div>
      </div>
      <ConfirmDialog
        open={pendingTab !== null}
        title="Discard unsaved changes?"
        message="You have changes on this page that haven't been saved. Leave without saving them?"
        confirmLabel="Discard changes"
        danger
        onCancel={() => setPendingTab(null)}
        onConfirm={() => {
          if (pendingTab) goTo(pendingTab);
          setPendingTab(null);
        }}
      />
    </SettingsDirtyContext.Provider>
  );
}
