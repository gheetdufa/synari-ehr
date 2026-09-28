# Security risk analysis (template)

Required by 45 CFR 164.308(a)(1)(ii)(A). Follows NIST SP 800-66 Rev. 2. Complete it before go-live,
review it yearly and after major changes (new integration, hosting move, incident).

- Organization:
- Prepared by / date:
- Scope: Synari deployment at `<domain>`, its hosting, integrations and the workstations used to
  reach it.

## 1. Asset inventory

| Asset | Owner | Location / provider | Holds PHI? | Notes |
|---|---|---|---|---|
| Synari API and worker containers | | | Yes (in memory) | |
| Postgres | | | Yes | Disk encryption: |
| File storage | | | Yes | |
| Backups | | | Yes | age recipients: |
| `DATA_ENCRYPTION_KEYS`, `SECRET_KEY` | | Secrets manager: | Keys | Escrow location: |
| Reverse proxy / TLS certificates | | | No | |
| Staff workstations and phones | | | Transient | MDM / disk encryption: |
| Integrations (see data-flows.md) | | | | |

## 2. Threats and vulnerabilities

For each asset, list realistic threats (examples: stolen laptop, phished staff credentials,
malicious insider, ransomware on the server, misconfigured storage bucket, lost backup, vendor
breach, software vulnerability, accidental disclosure by email) and existing controls.

| # | Threat / vulnerability | Assets | Existing controls (Synari + yours) | Likelihood (1–3) | Impact (1–3) | Risk (L×I) |
|---|---|---|---|---|---|---|
| 1 | Phished staff password | Accounts | Required 2FA, throttling, alerts on new devices | | | |
| 2 | Stolen database backup | Backups | age encryption, column encryption, key escrow separate | | | |
| 3 | Insider browsing records | Postgres | Role-based access, care teams, audit + access history, unusual-access alerts | | | |
| 4 | Server compromise | API, Postgres | Patching cadence, container isolation, least-privilege DB role | | | |
| 5 | Misdirected email | Email | Content-free notifications | | | |
| 6 | Vendor breach | Integrations | BAAs, minimal data sent | | | |
| 7 | Loss of service / ransomware | All | Encrypted off-site backups, restore tests | | | |
| … | | | | | | |

## 3. Risk treatment plan

| Risk # | Decision (mitigate / accept / transfer) | Action | Owner | Due |
|---|---|---|---|---|

## 4. Sign-off

Security officer: ________________  Date: ________
