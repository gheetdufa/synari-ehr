import type { ComponentType } from 'react';
import {
  Calendar,
  ChartColumn,
  ClipboardList,
  CreditCard,
  FileText,
  FolderLock,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Users,
  Video,
} from 'lucide-react';
import type { Session } from '../api/auth';

export interface NavItem {
  label: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: 'messages';
  /** Whether the signed-in staff member can use this area; always shown when omitted. */
  visible?: (session: Session) => boolean;
}

/** Sees clinical records: their own clients' as a clinician, or everyone's with clinical_all. */
export function seesClinicalRecords({ staff, capabilities }: Session): boolean {
  return staff.is_clinician || capabilities.includes('clinical_all');
}

const NAV: NavItem[] = [
  { label: 'Dashboard', to: '/portal', icon: LayoutDashboard, end: true },
  { label: 'Calendar', to: '/portal/calendar', icon: Calendar },
  { label: 'Clients', to: '/portal/clients', icon: Users },
  { label: 'Messages', to: '/portal/messaging', icon: MessageSquare, badge: 'messages', visible: seesClinicalRecords },
  {
    label: 'Telehealth',
    to: '/portal/telehealth',
    icon: Video,
    // Clinicians host their sessions; staff who manage every calendar share the join links.
    visible: ({ staff, capabilities }) => staff.is_clinician || capabilities.includes('schedule_all'),
  },
  { label: 'Notes', to: '/portal/notes', icon: FileText, visible: seesClinicalRecords },
  // Clients' requests for copies of and amendments to their record (clinical access).
  { label: 'Records', to: '/portal/records', icon: FolderLock, visible: seesClinicalRecords },
  { label: 'Forms', to: '/portal/forms', icon: ClipboardList },
  {
    label: 'Billing',
    to: '/portal/billing',
    icon: CreditCard,
    visible: ({ capabilities }) => capabilities.includes('billing_all') || capabilities.includes('billing_own'),
  },
  {
    label: 'Reports',
    to: '/portal/reports',
    icon: ChartColumn,
    visible: ({ capabilities }) => capabilities.includes('view_reports') || capabilities.includes('billing_own'),
  },
  { label: 'Settings', to: '/portal/settings', icon: Settings },
];

/** The sidebar items the signed-in staff member's role lets them use. */
export function navItemsFor(session: Session): NavItem[] {
  return NAV.filter((item) => !item.visible || item.visible(session));
}

/** Whether the signed-in staff member may open the area whose sidebar link is `to`. */
export function canOpenArea(session: Session, to: string): boolean {
  const item = NAV.find((entry) => entry.to === to);
  return !item?.visible || item.visible(session);
}
