# Synari web app

React 18 + TypeScript + Vite + Tailwind. One app serves the marketing site, the staff app
(`/portal`), the client portal (`/client`), telehealth join links (`/join/:token`) and public
booking pages (`/book/:slug`) and staff invitations (`/join-practice`).

```bash
cp .env.example .env
npm install
npm run dev          # http://localhost:5173 (API expected at VITE_API_URL)
npm run lint && npm run typecheck && npm test && npm run build
```

## Layout

```
src/
  api/          typed API modules; client.ts handles tokens, refresh and errors
  auth/         StaffAuth / ClientAuth providers, Require* route guards
  lib/          config, formatting, realtime (WebSocket), query client, analytics
  ui/           shared components: Button, Card, Form fields, Modal, Tabs, Toast, ...
  shared/       widgets used by both apps (NotificationBell)
  portal/       staff app pages, one folder per area (calendar/, clients/, notes/ ...)
  client/       client portal pages
  telehealth/   full-screen video session
  public/       unauthenticated pages (join link, booking, password reset, invitations)
  components/   marketing site
```

## Conventions

- **Data fetching** uses TanStack Query. Each `api/*.ts` module exports an API object and a
  `*Keys` factory for query keys. Mutations invalidate the keys they affect.
- **Long lists are paginated.** Staff list endpoints take `limit`/`offset` and send the number of
  matching rows in `X-Total-Count`; `apiPage()` returns `{ items, total }`. Show them with
  `usePagedQuery` (`lib/paging.ts`) and a `<LoadMore noun="…" {...list.loadMore} />` footer, and
  never load every client: pick one with `ClientPicker` / `ClientCombobox` from
  `portal/clients/ClientSearch.tsx`, which search on the server at an access level.
- **Realtime**: `useRealtimeEvent('message.*', handler)` inside a signed-in layout. Events carry
  ids only; handlers invalidate queries rather than patching data.
- **Two realms**: staff calls use the default `staff` realm; client-portal calls pass
  `{ realm: 'client' }` and use query keys starting with `'portal'`.
- **Session and permissions**: below `<RequireStaff>`, `useSession()` gives the signed-in
  `{ staff, practice, capabilities }` and `useCan('manage_practice')` answers role checks.
  Use them to hide or disable what someone can't do; the API still enforces access (403 for a
  missing capability, 404 for records out of reach). Tests render signed-in screens with
  `WithSession` and `testSession()` from `src/test/session.tsx`.
- **Sessions are server-side.** Refresh tokens rotate on every use, so `api/client.ts` refreshes
  under a Web Lock shared by all tabs. `session.idle_timeout_minutes` drives `IdleTimeout`, and a
  session with `mfa_setup_required` only shows the 2FA enrollment screen (`RequireStaff`).
- **Errors**: API calls throw `ApiError` with the server's message. Show it with
  `useToast().error(err)` or `<ErrorState>`; never swallow errors silently.
- **Times**: the API speaks UTC ISO strings. Display them with `lib/format.ts` in the
  signed-in staff member's `time_zone` (portal; the practice's for practice-wide accounting
  such as billing days) or the client's `time_zone` (client portal).
- **Money** is integer cents; format with `formatMoney`, parse input with `parseMoneyToCents`.
- **Styling**: Tailwind with the `primary` (teal) and `sage` palettes. Build pages from the
  `ui/` components so the app stays consistent. Pages must work on phones.
- **Privacy**: never log patient data to the console, never add analytics to app screens, and
  keep clinical content out of URLs.
