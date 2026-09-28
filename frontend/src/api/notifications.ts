import { api, type Realm } from './client';

export interface AppNotification {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  urgent: boolean;
  read_at: string | null;
  created_at: string;
}

const base = (realm: Realm) => (realm === 'staff' ? '/notifications' : '/portal/notifications');

/** In-app notifications for the signed-in staff member or client. */
export const notificationsApi = {
  list: (realm: Realm, unreadOnly = false) =>
    api<AppNotification[]>(base(realm), { realm, query: { unread_only: unreadOnly, limit: 30 } }),
  unreadCount: (realm: Realm) =>
    api<{ count: number }>(`${base(realm)}/unread-count`, { realm }),
  markRead: (realm: Realm, id: number) =>
    api<AppNotification>(`${base(realm)}/${id}/read`, { realm, method: 'POST' }),
  markAllRead: (realm: Realm) =>
    api<{ marked_read: number }>(`${base(realm)}/read-all`, { realm, method: 'POST' }),
};
