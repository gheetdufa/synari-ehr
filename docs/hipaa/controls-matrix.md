# Controls matrix

How Synari addresses the HIPAA Security Rule (45 CFR 164.308–164.316), the Privacy Rule rights
it must support (164.502, 164.524–164.528) and breach notification (164.400–414). "Operator" is
the organization running Synari. Evidence commands are run on the server from `backend/`
(prefix with `docker compose exec api` in the production compose setup).

## Technical safeguards (164.312)

| Requirement | Synari | Operator | Evidence |
|---|---|---|---|
| Unique user identification (a)(2)(i) | Every staff member and client has their own account; shared logins aren't supported. Guardians sign in to a minor's portal with their own email and are recorded as themselves. | Don't share accounts; deactivate leavers the same day (Settings → Team). | Team list; audit log filtered by actor |
| Emergency access procedure (a)(2)(ii) | Break-glass: clinicians outside a client's care team can open the chart (not billing) for 4 hours with a written reason of at least 20 characters; the primary clinician and owners are notified and owners review it; it doesn't allow exporting the record. `python -m synari.admin reset-mfa / unlock / create-owner` recovers access to accounts. | Define who may use break-glass and review every use. | Settings → Security → Emergency access; security events |
| Automatic logoff (a)(2)(iii) | Server-side sessions end after the practice's idle limit (default 30 minutes, at most 60) and after 12 hours regardless; the browser signs out at the same limit. | Set the idle limit; lock workstations. | Settings → Security; `auth_sessions` |
| Encryption and decryption (a)(2)(iv) | Clinical text, diagnoses, insurance identifiers, claim data and secrets are encrypted in the database with AES-256-GCM (`synari/crypto.py`); every stored file is encrypted with its own key. Keys come from `DATA_ENCRYPTION_KEYS`; rotation with `admin reencrypt`. | Encrypt disks and backups; keep `DATA_ENCRYPTION_KEYS` in a secrets manager, backed up separately; rotate keys yearly or after staff with key access leave. | `python -m synari.admin reencrypt` progress output; raw SQL shows `enc:v1:` values |
| Audit controls (b) | Sign-ins and every view or change of client records are logged with actor, client, IP and time. Events are sealed into a per-practice SHA-256 hash chain; the database refuses to update or delete sealed events. Logs are kept at least 6 years (`AUDIT_RETENTION_YEARS`). | Review the activity log on a schedule (see policies/audit-log-review.md). | `python -m synari.admin audit-verify`; Settings → Activity log export; client → Access history |
| Integrity (c)(1) and authenticating ePHI (c)(2) | Signed notes are locked; each signature stores a version with a SHA-256 hash that's checked whenever the note is read; changes after signing need a reason and create a new version; addenda never alter signed text. Signed forms carry a hash too. Messages are never hard-deleted. | — | Note → Versions; integrity badge; security events on mismatches |
| Person or entity authentication (d) | bcrypt password hashing, minimum length and a blocklist (optionally a breached-password check), required two-factor authentication for staff (TOTP with single-use recovery codes, replay-protected), sign-in throttling, passwordless single-use links for clients. | Keep staff 2FA required; train staff on phishing. | Settings → Security (2FA coverage); security events |
| Transmission security (e) | HTTPS only in production (HSTS, TLS 1.2+ via the bundled Caddy), encrypted SMTP required, content-free email and SMS, secure WebSockets, encrypted video (LiveKit, DTLS-SRTP). | Use the bundled reverse proxy or equivalent TLS; `sslmode=require` for managed databases. | SSL Labs report; `deploy/Caddyfile` |

## Administrative safeguards (164.308)

| Requirement | Synari | Operator | Evidence |
|---|---|---|---|
| Risk analysis and management (a)(1)(ii)(A–B) | This kit, the data-flow map and asset list templates. | Complete and review annually and after major changes ([risk-analysis-template.md](risk-analysis-template.md)). | Signed risk analysis |
| Sanction policy (a)(1)(ii)(C) | — | [policies/sanctions.md](policies/sanctions.md) | Signed policy, training records |
| Information system activity review (a)(1)(ii)(D) | Activity log with filters and export, per-client access history, security events feed (unusual access volume, lockouts, exports, emergency access, role changes). | Review weekly; document reviews. | Review log |
| Assigned security responsibility (a)(2) | — | Name a security officer. | Policy |
| Workforce security and access management (a)(3–4) | Roles with least privilege (billers and schedulers never see clinical records; clinicians see their own clients), care teams, deactivation revokes all sessions immediately. | Grant the narrowest role; review access quarterly. | Team list export |
| Security awareness and training (a)(5) | Log-in monitoring and alerts, password policy, 2FA. | Train staff at hire and yearly ([policies/workforce-training.md](policies/workforce-training.md)). | Training records |
| Security incident procedures (a)(6) | Security events, audit trail and per-client access history to scope incidents. | [policies/incident-response.md](policies/incident-response.md) | Incident log |
| Contingency plan (a)(7) | `admin backup` (encrypted with age, manifest, retention) and `admin restore-test` (proves backups and keys restore); alerts when backups or restore tests go stale. | Run backups daily off-site; test restores at least quarterly; keep keys escrowed ([policies/contingency-plan.md](policies/contingency-plan.md)). | Security events backup.completed / backup.restore_tested |
| Evaluation (a)(8) | — | Annual evaluation; vulnerability scans and penetration tests. | Reports |
| Business associate contracts (b) | [data-flows.md](data-flows.md) lists every vendor that can receive PHI. | Sign BAAs ([baa-checklist.md](baa-checklist.md)). | Signed BAAs |

## Physical safeguards (164.310)

| Requirement | Synari | Operator | Evidence |
|---|---|---|---|
| Facility access, workstation use and security (a–c) | Nothing stored on workstations beyond the browser session; automatic logoff. | Host with a provider that has physical controls and a BAA; lock screens; full-disk encryption on laptops. | Hosting BAA and attestations |
| Device and media controls (d) | Files are encrypted per file; deleting a file's key makes it unreadable (crypto-shredding). Records retention setting and a list of archived clients past retention. | [policies/media-disposal.md](policies/media-disposal.md) | Disposal log |

## Documentation (164.316)

Keep policies, procedures, risk analyses and evidence for 6 years from creation or last effective
date. Synari keeps audit events for at least 6 years.

## Privacy Rule rights and breach notification

| Requirement | Synari | Operator |
|---|---|---|
| Minimum necessary 164.502(b) | Role-based and care-team access; field-level restrictions (e.g. diagnoses and internal notes hidden from schedulers). | Assign roles by job need. |
| Right of access 164.524 | Clients request a copy of their record in the portal; staff see due dates (30 days, one 30-day extension); the release is shared in the portal or delivery to a third party is logged. Psychotherapy notes are excluded. | Respond on time; charge only permitted fees. |
| Amendment 164.526 | Clients request amendments; accepted ones become addenda; denials keep the reason, the client's disagreement and any rebuttal, and all are included in later disclosures. | Decide within 60 days. |
| Accounting of disclosures 164.528 | Disclosures log (manual and automatic for exports to third parties) and a per-client 6-year report. | Record disclosures made outside Synari. |
| Psychotherapy notes 164.501 / 164.508(a)(2) | A separate note type visible only to its author (and co-signing supervisor), excluded from exports, claims, the portal and AI. | Use for true psychotherapy notes only. |
| Breach notification 164.400–414 | Per-client access history, tamper-evident audit log and exports to determine what was accessed and by whom. Encrypted data with protected keys may qualify for the encryption safe harbor. | Follow [policies/incident-response.md](policies/incident-response.md): 4-factor risk assessment, notifications within 60 days. |
| Good Faith Estimates (No Surprises Act, 45 CFR 149.610) | Estimates for self-pay clients with due dates, required content and disclaimers, portal delivery, 6-year retention, $400 overage warnings and dispute holds. | Post the right-to-an-estimate notice; follow state rules. |

## Proposed Security Rule changes (NPRM, January 2025)

Not yet law (HHS's current target is 2027). Synari already covers the software parts: encryption
at rest and in transit, required MFA, audit integrity, restore testing within 72 hours, and a
supply-chain pipeline (dependency and image scanning, SBOM). Asset inventories, network maps,
segmentation, vulnerability scans every 6 months and annual penetration tests are the operator's.
