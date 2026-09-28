# Security policy

Synari handles protected health information, so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Instead, use GitHub's private vulnerability reporting
("Report a vulnerability" under the repository's **Security** tab), or email
gudadheer@gmail.com.

Include what you found, how to reproduce it, and the impact you expect. Never include real
patient data in a report. We'll acknowledge within 3 business days, keep you updated, and
credit you in the release notes unless you'd rather stay anonymous.

## Scope

In scope: this repository's code (API, worker, web app) and its default deployment
configuration. Out of scope: vulnerabilities in third-party services (Stripe, Twilio, LiveKit
Cloud, email providers) and issues that require a compromised server or admin account.

## Supported versions

Security fixes land on the latest release. Self-hosters should update promptly; see
[deploy/README.md](deploy/README.md#upgrades).

## Hardening checklist for operators

- Set a long random `SECRET_KEY` and `ENVIRONMENT=production`.
- Set `ALLOW_REGISTRATION=false` once your accounts exist.
- Serve everything over HTTPS (the included Caddy setup does this automatically).
- Set `DATA_ENCRYPTION_KEYS` and escrow it (and your backup's age private key) away from the
  server; rotate with `python -m synari.admin reencrypt`.
- Keep the database and file storage private and on encrypted disks; run the encrypted
  `backup` service and a `restore-test` at least every 90 days
  ([deploy/README.md](deploy/README.md#backups)).
- Only enable AI features with a provider that has signed a BAA with you.
