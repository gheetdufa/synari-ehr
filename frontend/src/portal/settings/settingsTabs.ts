import type { Capability, Session } from '../../api/auth';

export const SETTINGS_TABS = [
  'profile',
  'practice',
  'team',
  'locations',
  'booking',
  'availability',
  'services',
  'notifications',
  'messaging',
  'telehealth',
  'billing',
  'insurance',
  'documentation',
  'security',
  'records',
  'activity',
  'import',
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  profile: 'My profile',
  practice: 'Practice',
  team: 'Team',
  locations: 'Locations',
  booking: 'Scheduling & booking',
  availability: 'Availability',
  services: 'Services & rates',
  notifications: 'Reminders & notifications',
  messaging: 'Messaging',
  telehealth: 'Telehealth',
  billing: 'Billing',
  insurance: 'Insurance',
  documentation: 'Documentation',
  security: 'Security',
  records: 'Record retention',
  activity: 'Activity log',
  import: 'Import from SimplePractice',
};

const BILLING_SETTINGS_VIEWERS: Capability[] = ['manage_practice', 'billing_all', 'billing_own'];

/**
 * Tabs that only make sense for some people. Everything else is shown to everyone; practice-wide
 * settings are read-only without `manage_practice`.
 */
const TAB_VISIBILITY: Partial<Record<SettingsTab, (session: Session) => boolean>> = {
  availability: ({ staff, capabilities }) => staff.is_clinician || capabilities.includes('schedule_all'),
  telehealth: ({ staff, capabilities }) => staff.is_clinician || capabilities.includes('manage_practice'),
  billing: ({ capabilities }) => BILLING_SETTINGS_VIEWERS.some((capability) => capabilities.includes(capability)),
  insurance: ({ capabilities }) => capabilities.includes('billing_all') || capabilities.includes('billing_own'),
  documentation: ({ staff }) => staff.is_clinician,
  activity: ({ capabilities }) => capabilities.includes('view_audit_log'),
  import: ({ capabilities }) => capabilities.includes('manage_practice'),
};

/** The settings tabs the signed-in staff member sees, in display order. */
export function settingsTabsFor(session: Session): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => TAB_VISIBILITY[tab]?.(session) ?? true);
}

/** The tab named by `?tab=` when it's one of `visible`, otherwise the profile tab. */
export function settingsTabFrom(value: string | null, visible: readonly SettingsTab[]): SettingsTab {
  return (visible as readonly string[]).includes(value ?? '') ? (value as SettingsTab) : 'profile';
}
