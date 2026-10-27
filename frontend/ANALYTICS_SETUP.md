# Analytics (optional)

Synari ships with no analytics turned on. You can enable page analytics for the **public marketing
pages only**: `/`, `/about`, `/login`, `/register` and the legal pages. The
therapist app, client portal, video sessions and booking pages never load an analytics script or send
events, because those screens can show health information. See `src/lib/analytics.ts`.

## Google Analytics 4

1. Create a GA4 property and a web data stream, then copy its Measurement ID (`G-…`).
2. Set it in `frontend/.env` (or your hosting platform's build environment):

   ```env
   VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX
   ```

3. Rebuild the frontend. The gtag script loads the first time a marketing page is shown.

Events sent from marketing pages:

| Event | When |
| --- | --- |
| `page_view` | A marketing page is shown |
| `cta_click` | A header call-to-action is clicked |

## Vercel Web Analytics

If you host the frontend on Vercel, set `VITE_VERCEL_ANALYTICS=true`. The same marketing-page filter
applies: events from any other path are dropped before they are sent.

## Before you turn it on

Marketing analytics can still set cookies and collect IP addresses. Update the cookie and privacy
policies in `public/` to match what you enable, and add a consent banner where your visitors' laws
require one.
