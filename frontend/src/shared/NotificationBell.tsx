import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Realm } from '../api/client';
import { notificationsApi, type AppNotification } from '../api/notifications';
import { timeAgo } from '../lib/format';
import { useRealtimeEvent } from '../lib/realtime';
import { Popover } from '../ui/Display';
import { SectionSpinner } from '../ui/Spinner';

export const notificationKeys = {
  unread: (realm: Realm) => ['notifications', realm, 'unread'] as const,
  list: (realm: Realm) => ['notifications', realm, 'list'] as const,
};

/** Bell with an unread badge and a dropdown of recent notifications. */
export function NotificationBell({ realm }: { realm: Realm }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const unread = useQuery({
    queryKey: notificationKeys.unread(realm),
    queryFn: () => notificationsApi.unreadCount(realm),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications', realm] });
  useRealtimeEvent('notification.created', refresh);

  const markAll = useMutation({ mutationFn: () => notificationsApi.markAllRead(realm), onSuccess: refresh });
  const open = useMutation({
    mutationFn: (notification: AppNotification) =>
      notification.read_at ? Promise.resolve(notification) : notificationsApi.markRead(realm, notification.id),
    onSuccess: refresh,
  });

  const count = unread.data?.count ?? 0;
  return (
    <Popover
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
          className="relative inline-flex h-10 w-10 items-center justify-center rounded-lg text-sage-600 hover:bg-sage-100 hover:text-sage-900"
        >
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      )}
      className="w-[22rem] max-w-[calc(100vw-2rem)]"
    >
      {(close) => (
        <NotificationList
          realm={realm}
          onOpen={(notification) => {
            open.mutate(notification);
            close();
            if (notification.link) navigate(notification.link);
          }}
          onMarkAll={() => markAll.mutate()}
        />
      )}
    </Popover>
  );
}

function NotificationList({
  realm,
  onOpen,
  onMarkAll,
}: {
  realm: Realm;
  onOpen: (notification: AppNotification) => void;
  onMarkAll: () => void;
}) {
  const list = useQuery({ queryKey: notificationKeys.list(realm), queryFn: () => notificationsApi.list(realm) });
  return (
    <div>
      <div className="flex items-center justify-between border-b border-sage-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-sage-900">Notifications</h3>
        <button type="button" onClick={onMarkAll} className="text-xs font-medium text-primary-700 hover:underline">
          Mark all read
        </button>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {list.isLoading && <SectionSpinner />}
        {list.data?.length === 0 && <p className="px-4 py-8 text-center text-sm text-sage-500">You're all caught up.</p>}
        {list.data?.map((notification) => (
          <button
            key={notification.id}
            type="button"
            onClick={() => onOpen(notification)}
            className={`flex w-full gap-3 border-b border-sage-50 px-4 py-3 text-left hover:bg-sage-50 ${
              notification.read_at ? '' : 'bg-primary-50/50'
            }`}
          >
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                notification.read_at ? 'bg-transparent' : notification.urgent ? 'bg-red-600' : 'bg-primary-500'
              }`}
            />
            <span className="min-w-0 flex-1">
              <span className={`block text-sm ${notification.urgent ? 'font-semibold text-red-700' : 'text-sage-900'}`}>
                {notification.title}
              </span>
              {notification.body && <span className="block truncate text-xs text-sage-600">{notification.body}</span>}
              <span className="text-xs text-sage-500">{timeAgo(notification.created_at)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
