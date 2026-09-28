import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, CreditCard, FileText, FolderLock, Home, LogOut, MessageSquare, UserRound } from 'lucide-react';
import type { ComponentType } from 'react';
import { api } from '../api/client';
import { useClientAuth, usePortalClient } from '../auth/ClientAuth';
import { IdleTimeout } from '../auth/IdleTimeout';
import { RealtimeProvider, useRealtimeEvent } from '../lib/realtime';
import { usePublicConfig } from '../lib/usePublicConfig';
import { NotificationBell } from '../shared/NotificationBell';
import { actingContactNotice } from './portalViewer';

export const portalUnreadMessagesKey = ['portal', 'messages', 'unread-count'] as const;

function useUnreadMessages(enabled: boolean): number {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: portalUnreadMessagesKey,
    queryFn: () => api<{ count: number }>('/portal/messages/unread-count', { realm: 'client' }),
    enabled,
  });
  useRealtimeEvent(['message.*', 'conversation.read'], () =>
    queryClient.invalidateQueries({ queryKey: portalUnreadMessagesKey }),
  );
  return data?.count ?? 0;
}

interface Item {
  label: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  unread?: number;
}

function Nav() {
  const client = usePortalClient();
  const unread = useUnreadMessages(client.permissions.messaging);
  const items: Item[] = [
    { label: 'Home', to: '/client', icon: Home, end: true },
    { label: 'Appointments', to: '/client/appointments', icon: Calendar },
    ...(client.permissions.messaging ? [{ label: 'Messages', to: '/client/messages', icon: MessageSquare, unread }] : []),
    { label: 'Documents', to: '/client/documents', icon: FileText },
    ...(client.permissions.billing ? [{ label: 'Billing', to: '/client/billing', icon: CreditCard }] : []),
    { label: 'My records', to: '/client/records', icon: FolderLock },
  ];
  return (
    <nav aria-label="Portal" className="-mb-px flex gap-1 overflow-x-auto">
      {items.map(({ label, to, icon: Icon, end, unread: count }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium ${
              isActive ? 'border-primary-600 text-primary-800' : 'border-transparent text-sage-600 hover:text-sage-900'
            }`
          }
        >
          <Icon className="h-4 w-4" />
          {label}
          {count ? <span className="rounded-full bg-primary-600 px-1.5 text-xs text-white">{count}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * Shell for the client portal: practice name, navigation and sign-out, plus a banner naming the
 * guardian or contact when one signed in for the client.
 */
export default function ClientLayout() {
  const client = usePortalClient();
  const actingNotice = actingContactNotice(client);
  const { logout } = useClientAuth();
  const navigate = useNavigate();
  usePublicConfig();
  return (
    <RealtimeProvider realm="client">
      <div className="min-h-screen bg-sage-50">
        <header className="border-b border-sage-100 bg-white">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            <div className="flex h-16 items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-sage-900">{client.practice_name}</p>
                <p className="truncate text-xs text-sage-500">Client portal · {client.clinician_name}</p>
              </div>
              <div className="flex items-center gap-1">
                <NotificationBell realm="client" />
                <button
                  type="button"
                  onClick={async () => {
                    await logout();
                    navigate('/client/sign-in');
                  }}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-sage-700 hover:bg-sage-100"
                >
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </div>
            </div>
            <Nav />
          </div>
        </header>
        {actingNotice && (
          <div className="border-b border-primary-100 bg-primary-50">
            <p className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-2 text-sm text-primary-900 sm:px-6">
              <UserRound className="h-4 w-4 shrink-0" aria-hidden="true" />
              {actingNotice}
            </p>
          </div>
        )}
        <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
          <Outlet />
        </main>
        <IdleTimeout
          limitMinutes={client.idle_timeout_minutes}
          onTimeout={async () => {
            await logout();
            navigate('/client/sign-in', { replace: true, state: { reason: 'idle' } });
          }}
        />
      </div>
    </RealtimeProvider>
  );
}
