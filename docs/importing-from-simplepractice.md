# Importing a practice from SimplePractice

Synari can bring in a practice's clients, contacts, insurance, diagnoses, past sessions,
documents and outstanding balances from SimplePractice. Open **Settings → Import from
SimplePractice** (staff who manage the practice: owners, practice managers and clinicians with
practice-wide access). The wizard walks through the same steps as this page.

## 1. Download your files from SimplePractice

SimplePractice has no single "everything" export, so the importer combines several files.
Download as many as you can; only the Complete export or the Client details report is really
needed to get started.

| File | Where in SimplePractice | What it brings |
| --- | --- | --- |
| **Complete data export** (.zip) | Settings → Practice → Data export → Start export → Complete, all clients | Documents, notes, treatment plans, assessments, invoices and superbills (as PDFs), secure message transcripts, contact cards |
| **Client details** report (CSV or Excel) | Analytics (Reports) → Client details. Include Active, Inactive and Prospective clients and tick **Include Contacts** | Names, status, clinician, address, phone, email, primary insurance and member ID, a contact person |
| **Client demographics** report | Analytics (Reports) → Client demographics (Essential and Plus plans) | Date of birth, sex, gender identity (race, relationship status, employment and language go to the client's internal notes) |
| **Appointment status** report | Analytics (Reports) → Appointment status, whole date range, **Include Insurance** and **Include Documentation** | Past sessions with their CPT code and fee |
| **Attendance** report | Analytics (Reports) → Attendance, same date range | Show / no-show / late cancel / canceled, and location |
| **Outstanding balances** report | Analytics (Reports) → Outstanding balances | Each client's balance, as one opening invoice |
| **Client List** (optional) | Only from SimplePractice support when moving accounts | Payer ID, group, copay, subscriber details, diagnoses, minors, billing type |

The Complete export is password protected by default. Enter the password SimplePractice shows
with the download link in the wizard; the download link and the password expire after a week.
Both standard zip encryption and AES encryption are supported. If you download reports as
Excel files, keep them as `.xlsx` (old `.xls` files aren't supported; save as `.xlsx` or CSV).

## 2. Upload and check the columns

Upload every file at once. The importer recognizes each report from its column headings (in
any order, any capitalization) and shows what it detected; correct it if needed. For each
report you can see which column each field is read from and change it. Title rows above the
headings and "Total" rows are ignored. Dates are read as US dates (month first).

## 3. Analyze and review

**Analyze files** reads everything without changing any records and shows a preview:

- **Counts** of clients to add and to update, contacts, insurance policies, past sessions,
  documents (including psychotherapy notes and message transcripts) and balances.
- **Who's who.** SimplePractice's reports don't share a client ID, so clients are matched by
  name, ignoring order, capitalization, accents, middle initials and titles ("Doe, Jane M." is
  "Jane Doe"). A date of birth, email or phone tells apart clients who share a name, and a
  client's preferred name counts too ("Kate Smith" is "Katherine Smith" who goes by Kate).
  - Names that are only **similar** ("Katie Smith" and "Katherine Smith") are listed for you
    to confirm. Until you do, they're kept separate.
  - Names shared by **several clients** that nothing else tells apart are listed too; rows
    you don't assign are skipped.
  - Clients who may **already be in Synari** are recognized automatically by email or by
    name and date of birth. Same name without either is listed: choose the existing client
    to update, or add a new one.
- **Clinicians.** Each SimplePractice clinician is matched to a Synari clinician with the same
  name (a solo practice's clinician takes everyone). Choose someone else, invite a new
  clinician (needs permission to manage the team; they're emailed an invitation when the
  import runs), or leave them to a **default clinician**. Clients with no clinician in the files
  appear as "No clinician listed".
- **Options** to leave out contacts, insurance, sessions, documents or balances, and whether to
  create clients that appear only in session, balance or document files.
- **Warnings**: unreadable dates, rows without a client, files of types Synari doesn't store,
  duplicate names, missing columns and so on. Warnings never include client details.

Save your choices with **Update preview** to see the counts again, then **Start import**.

## 4. Import

The import runs in the background (the worker) and shows its progress live. You can leave the
page; you'll get a notification when it's done. Afterwards the results list what was created,
updated and skipped, with any warnings, and the uploaded files are deleted (the summary is
kept). Every step is recorded in the activity log with counts only.

## Where things end up

| From SimplePractice | In Synari |
| --- | --- |
| Clients | Clients (status, minor flag, billing type, demographics), care team with their clinician as primary and every clinician who saw them |
| Contacts (Client details, Client List, contact cards) | Client contacts; parents and guardians of minors are marked as guardians. No portal access is given |
| Insurance | Payers (matched by payer ID or name, or added) and each client's primary policy |
| Diagnoses (Client List) | The client's diagnosis codes |
| Appointment status + Attendance | Past appointments with the clinician, CPT code, fee, attendance and location |
| Complete export folders | Documents on the client's record, labeled with their folder: Administrative, Billing Documents, Medical Records, Psychotherapy Notes, Secure messages, Stored Documents |
| Outstanding balances | One open invoice per client: "Balance carried over from SimplePractice" |

## Known limits

- **No appointment times or durations.** SimplePractice's reports only have the date of
  service. Imported sessions start at **9:00 AM in the clinician's time zone**; a clinician's
  later sessions that day follow on the next hour (never after 9:00 PM). Durations come from
  the CPT code: 90832/90833 30 minutes, 90834/90836 45, 90837/90838 60, 90791/90792 60,
  90839 60, 90846/90847 50, 90849/90853 60, anything else 50. If your report has a time or
  duration column, it's used instead.
- **Notes arrive as PDFs.** Progress notes, treatment plans, assessments, intake
  questionnaires, invoices, superbills, claims and signed forms come in as documents, not as
  editable notes or billing records.
- **Future appointments aren't exported** by SimplePractice (only a "next appointment" date).
  Future rows are skipped; recreate upcoming appointments in Synari.
- **Imported history stays history.** Imported sessions are never invoiced, put on a claim,
  reminded, synced to calendars or counted as missing notes. Balances come in only as the
  opening invoices, without emails to clients. Credits (negative balances) aren't imported;
  record them as payments if you want to keep them.
- **Psychotherapy Notes** are only visible to the client's primary clinician (and the
  clinician they were filed under). They're never shared with the client or included in
  record exports.
- **Clients already in Synari** only have blank fields filled in; nothing you entered in
  Synari is overwritten. Clients the importer created are refreshed from the files if you run
  it again.
- **Couple and family records** in SimplePractice come in as one client each; review them.
- Synari needs a different email per client: when clients share one (a parent's email for
  two children), the second is left without it and a warning says so.
- Only file types Synari stores are imported (PDF, images, text, Word, audio); others are
  skipped and counted in the warnings. Files over the upload limit (`MAX_UPLOAD_BYTES`,
  50 MB by default) are skipped too.
- One Complete export per import. For several exports (e.g. one per clinician), run one
  import for each.

## Running it again

Imports remember what they created (by a key from the source, such as the client's name and
date of birth or the document's path in the export). Running the same files again, or
restarting an import that stopped with an error, picks up where it left off and never
duplicates clients, sessions, documents or balances.

## Privacy and security

- The zip password is stored encrypted and forgotten when the import finishes or is canceled.
- Uploaded files are stored like other files (practice-scoped keys in your storage), used only
  by the importer and never downloadable; they're deleted when the import completes or is
  canceled. After a failure they're kept so you can fix the problem and start again.
- Previews contain client names (needed to confirm matches) and are only shown to staff who
  manage the practice; viewing an import is audited. Notifications and live updates contain
  counts only.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMPORT_MAX_BYTES` | 2147483648 (2 GB) | Largest file the importer accepts. Uploads are streamed to storage in 8 MB parts. |

The bundled Caddy configuration doesn't limit request sizes. If you put another proxy in front
of the API, allow request bodies as large as `IMPORT_MAX_BYTES` (for nginx:
`client_max_body_size 2g;`) and generous timeouts for the upload.

## Sample files

`backend/tests/fixtures/simplepractice/` has a synthetic set (a Complete export zip with the
password `Synthetic-Export-2026` and each report as CSV or Excel) for trying the wizard. They
contain no real people.

## Troubleshooting

| Message | What to do |
| --- | --- |
| The export zip is password protected | Enter the password shown with the SimplePractice download link |
| The export zip's password is incorrect | Check the password; it expires with the link after a week (start a new export) |
| This file isn't a complete zip archive / couldn't be read | The download was interrupted; download the export again |
| Old Excel files (.xls) aren't supported | Download the report as .xlsx or CSV |
| … has no column for … | Fix that report's column mapping, then analyze again |
| Choose who becomes … in Synari, or a default clinician | Map every SimplePractice clinician or pick a default clinician |
