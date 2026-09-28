import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Menu, Settings, X } from 'lucide-react';
import { ROLE_LABELS } from '../api/auth';
import { messagesApi } from '../api/messages';
import { IdleTimeout } from '../auth/IdleTimeout';
import { useSession, useStaffAuth } from '../auth/StaffAuth';
import { Brand } from '../components/BrandMark';
import '../components/brand-mark.css';
import { initials } from '../lib/format';
import { RealtimeProvider, useRealtimeEvent } from '../lib/realtime';
import { usePublicConfig } from '../lib/usePublicConfig';
import { NotificationBell } from '../shared/NotificationBell';
import { Avatar, Popover } from '../ui/Display';
import { AskSynari } from './ai/AskSynari';
import { navItemsFor, seesClinicalRecords } from './navigation';

export const unreadMessagesKey = ['messages', 'unread-count'] as const;

/** Unread client messages in the signed-in clinician's own conversations, kept current. */
export function useUnreadMessages(enabled: boolean): number {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: unreadMessagesKey,
    queryFn: messagesApi.unreadCount,
    enabled,
  });
  useRealtimeEvent(['message.*', 'conversation.read'], () =>
    queryClient.invalidateQueries({ queryKey: unreadMessagesKey }),
  );
  return data?.count ?? 0;
}

/** The main navigation, limited to the areas the signed-in staff member's role can use. */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const session = useSession();
  const unread = useUnreadMessages(seesClinicalRecords(session));
  return (
    <nav className="flex-1 space-y-1" aria-label="Main">
      {navItemsFor(session).map(({ label, to, icon: Icon, end, badge }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isActive ? 'bg-primary-50 text-primary-800' : 'text-sage-700 hover:bg-sage-100 hover:text-sage-900'
            }`
          }
        >
          <Icon className="h-5 w-5 shrink-0" />
          <span className="flex-1">{label}</span>
          {badge === 'messages' && unread > 0 && (
            <span className="rounded-full bg-primary-600 px-2 py-0.5 text-xs font-semibold text-white">{unread}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function UserMenu() {
  const { staff, practice } = useSession();
  const { logout } = useStaffAuth();
  const navigate = useNavigate();
  usePublicConfig();
  return (
    <Popover
      className="w-56"
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle} className="flex items-center gap-2 rounded-lg p-1 hover:bg-sage-100" aria-label="Account menu">
          <Avatar label={initials(staff)} />
          <span className="hidden max-w-[14rem] text-left text-sm sm:block">
            <span className="block truncate font-medium text-sage-900">
              {staff.first_name} {staff.last_name}
            </span>
            <span className="block truncate text-xs text-sage-500">
              {ROLE_LABELS[staff.role]} · {practice.name}
            </span>
          </span>
        </button>
      )}
    >
      {(close) => (
        <div className="py-1 text-sm">
          <div className="border-b border-sage-100 px-4 py-2 sm:hidden">
            <p className="truncate font-medium text-sage-900">
              {staff.first_name} {staff.last_name}
            </p>
            <p className="truncate text-xs text-sage-500">
              {ROLE_LABELS[staff.role]} · {practice.name}
            </p>
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sage-700 hover:bg-sage-50"
            onClick={() => {
              close();
              navigate('/portal/settings');
            }}
          >
            <Settings className="h-4 w-4" /> Settings
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sage-700 hover:bg-sage-50"
            onClick={async () => {
              close();
              await logout();
              navigate('/login');
            }}
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </Popover>
  );
}

/** Shell for the staff app: sidebar, top bar with notifications, and the page outlet. */
export default function PortalLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { logout } = useStaffAuth();
  const { idle_timeout_minutes: idleTimeoutMinutes } = useSession();
  const navigate = useNavigate();
  return (
    <RealtimeProvider realm="staff">
      <div className="min-h-screen bg-sage-50">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-sage-100 bg-white px-3 py-5 lg:flex">
          <div className="mb-6 px-3 [&_.stack-mark]:w-7">
            <Brand wordClassName="text-lg font-semibold text-sage-900" />
          </div>
          <SidebarNav />
        </aside>

        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-sage-900/40" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-white px-3 py-5 shadow-xl">
              <div className="mb-6 flex items-center justify-between px-3 [&_.stack-mark]:w-7">
                <Brand wordClassName="text-lg font-semibold text-sage-900" />
                <button type="button" aria-label="Close menu" onClick={() => setMobileOpen(false)} className="rounded-lg p-1 hover:bg-sage-100">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <SidebarNav onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        )}

        <div className="lg:pl-60">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-sage-100 bg-white/90 px-4 backdrop-blur sm:px-6">
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-sage-700 hover:bg-sage-100 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <NotificationBell realm="staff" />
              <UserMenu />
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
            <Outlet />
          </main>
        </div>
        <AskSynari />
        <IdleTimeout
          limitMinutes={idleTimeoutMinutes}
          onTimeout={async () => {
            await logout();
            navigate('/login', { replace: true, state: { reason: 'idle' } });
          }}
        />
      </div>
    </RealtimeProvider>
  );
}
