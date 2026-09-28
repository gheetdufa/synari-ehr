# Self-hosting Synari

This folder runs the whole stack on one Linux server with Docker: the web app, API, background
worker, Postgres, a LiveKit video server, and Caddy for automatic HTTPS.

## What you need

- A server with 2 vCPU / 4 GB RAM or more, Docker and the Docker Compose plugin.
- Two DNS names pointing at the server, for example `app.example.com` (the app) and
  `video.example.com` (video signaling).
- Open ports: TCP 80 and 443 and UDP 443 (HTTPS and HTTP/3), TCP 7881 and UDP 50000–50100
  (video media).
- An SMTP account for email (Amazon SES, Postmark, Mailgun, Resend, Google Workspace...).
  Clients sign in with emailed links, so email is required.

## Install

```bash
git clone <your fork of this repo> synari && cd synari/deploy
cp .env.example .env                 # domains, database password, LiveKit key/secret
cp synari.env.example synari.env     # SECRET_KEY, SMTP, and any optional integrations
docker compose up -d --build
```

Open `https://app.example.com/register` to create your account, then set
`ALLOW_REGISTRATION=false` in `synari.env` and run `docker compose up -d` again so nobody else
can sign up. Finish setup in **Settings**: profile and credentials, services and rates,
availability, and your online booking link.

Database migrations run automatically when the `api` container starts.

## Optional integrations

| Feature | Settings | Notes |
|---|---|---|
| Card payments, AutoPay | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Add a webhook to `https://<app>/api/webhooks/stripe` for `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`. |
| SMS reminders | `TWILIO_*` | Point the number's incoming-message webhook at `https://<app>/api/webhooks/twilio/sms` so STOP/START work. |
| AI note drafting, transcription | `OPENAI_API_KEY` (+ `OPENAI_BASE_URL` for other OpenAI-compatible providers) | Sends session content to the provider. Only enable with a provider that has signed a BAA with you. |
| S3 file storage | `STORAGE_BACKEND=s3`, `S3_*` | Otherwise files live in the `files` Docker volume. |
| Google Calendar / Outlook sync | `GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*` | See [Calendar sync](#calendar-sync). |
| LiveKit Cloud instead of self-hosted video | In `docker-compose.yml` set `LIVEKIT_URL` to your project's `wss://…` URL; put its key and secret in `.env` | Then remove the `livekit` service, its ports and its Caddy block. |

## Encryption keys

Synari encrypts clinical text, identifiers and tokens in the database, and every stored file
with its own key, using the master keys in `DATA_ENCRYPTION_KEYS`. Without them nothing can be
read back: not the live data, not a backup.

- **Escrow the keys.** Keep a copy of `DATA_ENCRYPTION_KEYS` (and `SECRET_KEY`) in a password
  manager or vault that two people can reach, separate from the server and from the backups.
- **Rotate** by adding a new key at the front, keeping the old ones after it
  (`DATA_ENCRYPTION_KEYS=k2:...,k1:...`), then run `docker compose up -d` and
  `docker compose exec api python -m synari.admin reencrypt`. It re-encrypts every encrypted
  column and every file's key (files themselves aren't rewritten), prints its progress, and
  can be stopped and run again. Remove the old key once a second run reports nothing left.
- Deleting a file's record destroys its key, so copies of the file in old backups or bucket
  versions become unreadable too.

## Backups

`python -m synari.admin backup` writes an encrypted backup of the database (`pg_dump`) and the
file volume to `BACKUP_TARGET`, and keeps the newest `BACKUP_RETENTION_COUNT` (default 14).
Everything is encrypted with [age](https://age-encryption.org) to the public keys in
`AGE_RECIPIENTS` while it's written, so the server can make backups but can't read them. Each
backup folder has a `manifest.json` with SHA-256 checksums and row counts (no data).

1. On your own computer (not the server), create a key pair with
   [age-keygen](https://github.com/FiloSottile/age#installation) (or `rage-keygen`):
   `age-keygen -o synari-backup-key.txt`. It prints the public key (`age1...`). Store the key
   file like the encryption keys above: offline, escrowed, separate from the backups.
2. In `synari.env` set `AGE_RECIPIENTS=age1...` (several comma-separated keys are fine, e.g.
   yours and a colleague's) and `BACKUP_TARGET`. The default `/backups` is a Docker volume on
   this server; for a real off-site copy use `BACKUP_TARGET=s3://bucket/prefix`, ideally a
   separate bucket with versioning or object lock (it uses the `S3_*` credentials).
3. Turn on the backup service, which backs up at start-up and every 24 hours: add
   `COMPOSE_PROFILES=backup` to `.env` (so every later `docker compose up -d`, including
   upgrades and config changes, keeps it running and up to date), then `docker compose up -d`.
   It also backs up whenever it restarts, and retention counts every backup, so raise
   `BACKUP_RETENTION_COUNT` if you restart often and want two weeks of daily copies.

**Test restores.** `python -m synari.admin restore-test` restores the newest backup into a
throwaway database, runs `alembic check`, compares every table's row count with the manifest,
decrypts a sample of every encrypted column and of the stored files (proving the backup and
your escrowed keys work together), then drops the database. Run it at least every 90 days,
ideally on a separate machine with its own Postgres (`RESTORE_TEST_DATABASE_URL`, a user with
CREATEDB) and the same `DATA_ENCRYPTION_KEYS`. On this server, pass the private key on
standard input so it's never stored there or mounted into a container:

```bash
docker compose run --rm -T backup \
  python -m synari.admin restore-test --identity - < synari-backup-key.txt
```

Backups and restore tests record security events (`backup.completed`, `backup.failed`,
`backup.restore_tested`, `backup.restore_test_failed`). When `BACKUP_TARGET` is set the worker
raises `backup.overdue` after 26 hours without a backup and `backup.restore_test_overdue`
after 90 days without a restore test. Leave `BACKUP_TARGET` empty only if you back up another
way (for example managed Postgres snapshots plus bucket replication).

To restore for real: decrypt with `age -d -i synari-backup-key.txt database.dump.age >
synari.dump`, `pg_restore --no-owner -d synari synari.dump` into an empty database, extract
`files.tar.age` the same way into the files volume, and start Synari with the same
`DATA_ENCRYPTION_KEYS`.

## Network and transport security

- Caddy serves TLS 1.2+ only and sends HSTS. Neither Caddy nor the web container keeps an access
  log, because request paths can carry sign-in and video tokens; the API logs route templates (`/api/telehealth/join/{token}`)
  as JSON with emails, phone numbers and tokens redacted.
- The API trusts forwarded client addresses only from `FORWARDED_ALLOW_IPS`: Caddy's fixed
  address on the Compose network (`CADDY_IP` in `.env`, default `172.30.0.10`). On a platform
  (Railway, Render, Fly) set it to your platform's proxy range, or `*` only if nothing but the
  platform's proxy can reach the container.
- The web app's Content-Security-Policy allows connections to its own origin plus
  `CSP_CONNECT_SRC` (set in `docker-compose.yml` to your LiveKit domain). If you use LiveKit
  Cloud or host the API on another domain, add those origins, for example
  `CSP_CONNECT_SRC=https://api.example.com wss://*.livekit.cloud https://*.livekit.cloud`.
- In production the API refuses to start with a non-HTTPS `FRONTEND_URL` or with
  `SMTP_SECURITY=none` to a mail server outside this machine or Docker network, and warns
  when a remote `DATABASE_URL` lacks `sslmode=require` (or `verify-full`). Its interactive
  docs (`/api/docs`) are off.
- Finished emails and texts keep only their envelope (recipient, status, times) after 7 days;
  their subject and body are cleared.

## Upgrades

```bash
git pull
docker compose up -d --build
```

## Scaling

One API process is plenty for a solo or small group practice. For a larger group practice:

- Run several API processes: set `WEB_CONCURRENCY` in `synari.env` (uvicorn worker processes;
  about one per vCPU). Realtime updates travel through Postgres, so every process delivers
  them to the browsers connected to it.
- Each process (every API worker and the background worker) has its own database pool:
  `DB_POOL_SIZE` connections kept open (default 5), up to `DB_MAX_OVERFLOW` more under load
  (default 10), and a request waits up to `DB_POOL_TIMEOUT` seconds (default 30) for one.
  Each API process also holds one connection for realtime updates. Keep
  `(WEB_CONCURRENCY + 1) × (DB_POOL_SIZE + DB_MAX_OVERFLOW + 1)` below Postgres'
  `max_connections` (100 by default), with room left for backups and admin sessions.
- Long lists (clients, invoices, notes, claims...) are paged, so screens stay fast as the
  practice's history grows. `backend/perf/README.md` has the load test and measured numbers.

## Running on a platform instead (Railway, Render, Fly...)

Run the backend image twice: once as the API (default command) and once as the worker
(`python -m synari.worker`), or once with `RUN_WORKER_IN_API=true` for a single small instance.
Build the frontend with `VITE_API_URL` set to the API's public URL (for example
`https://api.example.com/api`) and set the API's `FRONTEND_URL`/`CORS_ORIGINS` to the web
app's URL and `PUBLIC_API_URL` to the API's (`https://api.example.com`, for calendar sync). Use managed Postgres, S3-compatible storage (containers on these platforms have
ephemeral disks) and LiveKit Cloud.

`backend/railway.json` and `frontend/railway.json` build both services from their Dockerfiles on
Railway. The web image serves on port 3000 and takes `VITE_API_URL` as a build argument. Give
the web service `CSP_CONNECT_SRC` with the API's origin and your LiveKit Cloud origins (see
"Network and transport security"), and the API `FORWARDED_ALLOW_IPS` for the platform's proxy.

## Insurance claims

Claims, claim acknowledgments, ERAs (insurance payments) and eligibility checks go through
[Stedi](https://www.stedi.com) when `STEDI_API_KEY` is set in `synari.env` (see
`backend/.env.example`). Stedi is pay-as-you-go and signs a BAA. Start with a test key and
`STEDI_USAGE=T`: test claims go to Stedi's test payer and come back with a test acknowledgment
and ERA. Switch to a production key and `STEDI_USAGE=P` when you go live.

Without a clearinghouse key you can still file claims: download them as standard X12 837P
files and upload them to any clearinghouse (for example Office Ally), then upload the 999,
277CA and 835 files you get back under **Billing → Insurance payments**. Set your submitter and
receiver ids for that clearinghouse under **Settings → Insurance**. Claims can also be printed
on red CMS-1500 forms.

Before your first claims:
- Fill in **Settings → Practice** (billing address as a street address, tax id, group NPI and
  taxonomy if you bill as an organization) and each clinician's NPI and taxonomy.
- Add your payers under **Settings → Insurance** with the clearinghouse's payer ids.
- Enroll with each payer for ERAs (and for claims where the payer requires it) through your
  clearinghouse. A payer sends ERAs to one clearinghouse only, so enrolling moves them.

## Calendar sync

Clinicians can connect their own Google Calendar or Outlook/Microsoft 365 account under
**Settings → Availability**. Synari then adds their appointments to a separate "Synari"
calendar in that account and reads their busy times (never titles) so online booking doesn't
offer times they're busy; staff scheduling shows a warning instead of blocking. Events carry
no client details: they say "Appointment" (or "Busy" for events), are private, invite no one and
contain no video links or notes. The private calendar subscription link (ICS) keeps working
alongside.

Each provider turns on when its client id and secret are in `synari.env`. You register your own
OAuth app with each provider; its redirect URI must match exactly:

- Google: `https://<SYNARI_DOMAIN>/api/calendar-sync/google/callback`
- Microsoft: `https://<SYNARI_DOMAIN>/api/calendar-sync/microsoft/callback`

(With the API on its own domain, set `PUBLIC_API_URL` to it and use that instead.)

**Google** (Google Cloud console):

1. Create a project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen. If your practice uses Google Workspace, choose
   **Internal**: only your organization's accounts can connect, no Google verification is
   needed, and Calendar is covered by the Workspace BAA once your admin accepts it. Otherwise
   choose **External** and **publish it to Production**. Never leave it in **Testing**: test
   apps' refresh tokens expire after 7 days, so every calendar disconnects weekly. An
   unverified production app shows a warning screen to users and is limited to 100 accounts
   until Google verifies it.
3. Add the scopes `openid`, `email`, `.../auth/calendar.app.created` and
   `.../auth/calendar.freebusy`. Synari can only create and edit its own calendar and see free
   or busy times; it can't read your events.
4. Create an **OAuth client ID** of type **Web application** with the redirect URI above, and
   put its id and secret in `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.

**Microsoft** (Microsoft Entra admin center → App registrations):

1. **New registration**. Supported account types: your organization only (then set
   `MICROSOFT_OAUTH_TENANT` to your tenant id), or any organization plus personal accounts
   (keep `MICROSOFT_OAUTH_TENANT=common`).
2. Redirect URI: platform **Web**, the URI above.
3. **API permissions** → Microsoft Graph → delegated `openid`, `offline_access`, `User.Read`,
   `Calendars.ReadWrite`. Grant admin consent for your organization if your tenant requires it.
4. **Certificates & secrets** → new client secret. Put the application (client) id and the
   secret's value in `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET`.

**Rotating secrets.** Microsoft client secrets expire (at most 24 months): before that, add a
new secret, put it in `synari.env`, run `docker compose up -d`, then delete the old one.
Connections keep working because only the server's secret changes. Rotate a Google client
secret the same way (Google lets a client have two secrets at once). If a secret expires, every
connection shows a problem in Settings until the new one is in place.

If a user revokes access or their refresh token expires, Synari pauses their sync, keeps their
last busy times blocking availability, and sends them one email and in-app notice to reconnect.
Disconnecting deletes the tokens (and optionally the Synari calendar) and revokes Google's
grant; Microsoft users can also remove the app under their account's app permissions.

Only turn on **Show client initials on synced appointments** (Settings → Availability, owners
and practice managers) if every connected account is covered by a BAA, such as Google
Workspace or Microsoft 365 with a signed BAA. Personal Gmail and Outlook.com accounts aren't.

## HIPAA and your responsibilities

Synari gives you the technical safeguards: per-practice data isolation, required staff
two-factor authentication with server-side sessions and idle sign-out, encryption of clinical
data and files (see "Encryption keys"), encrypted backups with restore tests (see "Backups"),
a tamper-evident audit log with each client's access history, content-free email and SMS,
consent-gated recording, and automatic deletion of session audio once a note is signed.
[docs/hipaa](../docs/hipaa/README.md) maps each HIPAA Security Rule standard to what Synari does
and what you must do, with policy templates, a risk analysis template and a go-live checklist
([operator-checklist.md](../docs/hipaa/operator-checklist.md)). Compliance also depends on how
you run it:

- Sign a Business Associate Agreement with every vendor that stores or processes client
  data for you: your server or cloud host, database host, email provider, SMS provider, file
  storage, LiveKit Cloud (if used), your clearinghouse (if you file claims), your AI
  provider (if enabled) and Google Workspace or Microsoft 365 (if clinicians sync calendars).
- Encrypt disks and backups at rest, keep the server patched, restrict SSH access, and use
  strong unique passwords.
- Review the consent and policy templates in **Forms** against your jurisdiction's rules
  before sending them to clients.
- Periodically review **Settings → Activity log**.
