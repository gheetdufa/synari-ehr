# Synari

**Open-source practice management for therapy practices.** Scheduling, a client portal,
secure messaging, telehealth, intake forms, clinical notes, billing and insurance claims in one
self-hostable app, for a solo therapist or a group practice: a free alternative to
SimplePractice that you can run yourself.

Licensed under the [GNU AGPL-3.0](LICENSE).

## Features

**Group practices**
- **Team and roles**: invite staff by email as owner, clinician (basic, billing, full client
  list or entire-practice access), practice manager, biller or scheduler. Billers, schedulers
  and managers never see clinical records.
- **Care teams**: each client has a primary clinician and can share others; clinicians see
  only their own clients unless their role allows more. Supervisors see their supervisees'
  clients and co-sign their notes.
- **Per-clinician calendars and rates**: everyone sees the practice calendar (colleagues'
  appointments show as busy), services are practice-wide with per-clinician rates, and each
  clinician sets their own availability. Multiple office locations with place-of-service codes.
- **Reports**: income by clinician, sessions and attendance, client and insurance aging, claims
  by payer and status, all exportable as CSV.
- **Import from SimplePractice**: bring over clients, contacts, insurance, diagnoses, past
  sessions, documents and balances from SimplePractice's exports, with a preview to confirm
  matches first ([how it works](docs/importing-from-simplepractice.md)).

**For clinicians**
- **Calendar**: individual, couples/family and group sessions (up to 15 clients, each with
  their own attendance, fee, reminders and video link), events, recurring series (DST-safe),
  conflict checks for clinicians and clients. Two-way sync with Google Calendar and Outlook /
  Microsoft 365: appointments appear in your own calendar without client details, and your
  personal busy times block online booking.
- **Clients**: full chart with demographics, diagnoses (ICD-10), insurance and subscriber
  details, prior authorizations, contacts (guardians, emergency contacts, who pays the bills),
  portal permissions and communication consent.
- **Online booking**: a practice booking page where new clients pick a clinician and a time,
  and in-portal requests for existing clients; staff accept or decline every request.
- **Reminders**: email and SMS reminders to clients and guardians (with the video link for
  telehealth), STOP/START opt-out, cancellation notices.
- **Telehealth**: private per-appointment rooms on [LiveKit](https://livekit.io) (self-hosted
  or cloud), a waiting room, screen sharing, chat, group sessions, no client app needed.
- **Secure messaging**: a thread per client and clinician, attachments, read receipts, away
  messages, and crisis language flagged to the clinician and their supervisor.
- **Forms**: intake questionnaire, consent templates, scored PHQ-9/GAD-7 with safety flags;
  build your own; clients or guardians sign electronically.
- **Notes**: SOAP, DAP, BIRP, GIRP, PIRP, SIRP or free-form; group notes for every member;
  sign, lock and supervisor co-signature. Signed notes keep hashed revisions and take addenda;
  psychotherapy notes are kept apart from the record, for their author only.
- **Optional AI assistant**: turns session notes, dictation or a consented recording into a
  draft note for you to review. Off unless you configure a provider.

**Billing and insurance**
- **Client billing**: automatic daily invoicing, copays for insured clients, card payments
  (Stripe), saved cards, AutoPay, refunds, credits, bills addressed to a guardian, superbills.
- **Insurance claims**: build claims from attended sessions, check them before sending, and
  submit through the [Stedi](https://www.stedi.com) clearinghouse API, as a standard X12 837P
  file for any other clearinghouse, or printed on CMS-1500 forms. Corrected, voided and
  secondary claims.
- **ERAs**: insurance payments (835s) post automatically when they match and balance, write off
  contractual adjustments and bill the client their patient responsibility; anything else waits
  for review.
- **Eligibility**: real-time insurance eligibility checks (270/271), on demand or automatically.
- **Good Faith Estimates** (No Surprises Act): Synari notices when a self-pay client needs one
  (and by when), fills it from your services and schedule, issues it as a compliant PDF in the
  client's portal, supersedes it when care changes, and warns before you bill $400 or more
  above it. Clients can request one from the portal.

**Security and HIPAA safeguards**: required two-factor authentication for staff, server-side
sessions with an idle limit and per-device sign-out, sign-in throttling, break-glass emergency
access with review, encryption of clinical data and every stored file (with key rotation),
encrypted backups with restore tests, and a tamper-evident audit log (hash-chained, append-only)
with each client's access history, accounting of disclosures, record copies and amendments.
See [docs/hipaa](docs/hipaa/README.md) for the controls matrix, policies and go-live checklist.

**For clients and guardians**: a passwordless portal to see appointments and join video,
request appointments, message their clinicians, complete forms, upload documents and pay
bills. Parents and guardians sign in to a minor's portal with their own email.

## Quick start (development)

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Node 24 (what CI and the Docker image use; `frontend/.nvmrc`).

```bash
make services                          # Postgres, Mailpit (email catcher) and a LiveKit dev server
cp backend/.env.example backend/.env   # set SECRET_KEY (openssl rand -hex 32)
cp frontend/.env.example frontend/.env
cd backend && uv sync && uv run alembic upgrade head && cd ..
cd frontend && npm install && cd ..

make api      # http://localhost:8000/api/docs
make worker   # reminders, invoices, email delivery
make web      # http://localhost:5173
```

Register at http://localhost:5173/register. Emails (client sign-in links, reminders) appear in
Mailpit at http://localhost:8025.

## Self-hosting

See [deploy/README.md](deploy/README.md) for a single-server setup with automatic HTTPS, and
for running on hosting platforms.

## Architecture

| Part | Stack |
|---|---|
| API (`backend/`) | Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Postgres |
| Worker | Same codebase (`python -m synari.worker`): email/SMS outbox, reminders, invoicing, AutoPay, claim submission and clearinghouse polling, eligibility checks, transcription |
| Realtime | WebSockets fanned out across API processes with Postgres LISTEN/NOTIFY |
| Web (`frontend/`) | React 18, TypeScript, Vite, Tailwind, TanStack Query |
| Video | LiveKit (self-hosted or LiveKit Cloud) |
| Integrations (all optional) | Any SMTP provider, Twilio, Stripe, Stedi (claims, ERAs, eligibility), Google Calendar and Microsoft 365, S3-compatible storage, OpenAI-compatible AI |

Developer guides: [backend/README.md](backend/README.md) and [frontend/README.md](frontend/README.md).

## Privacy and compliance

Synari is built for protected health information: data is isolated per practice, every access
to client records is audited, emails and texts never contain clinical content, recordings
require every participant's consent, and session audio is deleted when the note is signed.
There is no official "HIPAA certification" for software. Synari implements the technical
safeguards of the Security Rule and documents how each is met in
[docs/hipaa/controls-matrix.md](docs/hipaa/controls-matrix.md), which also maps to what
HITRUST or SOC 2 assessors ask for. Running a HIPAA-compliant practice also requires Business
Associate Agreements with your hosting and service providers, a risk analysis, policies and
training ([docs/hipaa](docs/hipaa/README.md),
[deploy/README.md](deploy/README.md#hipaa-and-your-responsibilities)). Synari is software, not
legal advice; the consent templates are starting points to review for your jurisdiction.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md).

The Synari name and logo are trademarks of their owners and aren't covered by the code
license; please use a different name for distributions you modify substantially.
