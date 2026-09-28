# Where protected health information goes

| Component | What it holds or receives | PHI? | BAA needed |
|---|---|---|---|
| Postgres database | Everything: clients, appointments, notes, messages, forms, billing, claims, audit log. Clinical text and identifiers are encrypted by the app; names, emails, phones, dates and amounts are not (they're searched), so encrypt the disk. | Yes | Yes, with your database host |
| File storage (local volume or S3-compatible) | Uploaded documents, message attachments, session audio (until the note is signed), PDFs, record releases, imports, backups. Every file is encrypted per file. | Yes | Yes, with your storage provider |
| Backups | Encrypted database dump and files (age). | Yes | Yes, with wherever backups are stored |
| Email (SMTP provider) | Recipient address, practice name, and a link. Never clinical content, diagnoses or appointment details beyond "you have an upcoming appointment". | Minimal (identifiers) | Yes (the fact someone is a client is PHI) |
| SMS (Twilio) | Phone number and appointment reminder time; STOP/START replies. | Minimal | Yes (Twilio signs BAAs on eligible plans) |
| Card payments (Stripe) | Client or billing contact name, email, amount. No clinical content. | Minimal | Stripe states it isn't a business associate for payment processing (HIPAA 1179 exemption); confirm with counsel |
| Insurance clearinghouse (Stedi) | Claims (diagnoses, procedures, dates, member and provider identifiers), eligibility checks, remittances. | Yes | Yes (Stedi signs BAAs) |
| Video (LiveKit, self-hosted or Cloud) | Live audio/video between participants; nothing stored unless the session is recorded, which Synari does itself. | Yes (in transit) | Yes if you use LiveKit Cloud |
| AI provider (optional) | Session notes, dictation and consented recordings sent for drafting and transcription. Psychotherapy notes are never sent. | Yes | Yes, or leave AI off |
| Google Calendar / Microsoft 365 (optional sync) | Appointment times with the title "Appointment" (or client initials if you turn that on); no names, notes or links. | Minimal | Only use accounts covered by your Google Workspace or Microsoft 365 BAA |
| Web browsers | The signed-in session; nothing is kept after sign-out except the access token in local storage until it expires. | Transient | — |

## Flows

1. Staff and clients reach the web app and API over HTTPS through the reverse proxy (Caddy).
2. The API and worker read and write Postgres and file storage on a private network.
3. The worker sends email and SMS from the outbox, submits claims and polls the clearinghouse,
   syncs calendars and runs backups.
4. Video goes browser-to-LiveKit (and between participants) over DTLS-SRTP.
5. The optional AI assistant sends text or audio to the configured provider and stores the draft
   result encrypted.

Keep this document with your risk analysis and update it when you enable a new integration.
