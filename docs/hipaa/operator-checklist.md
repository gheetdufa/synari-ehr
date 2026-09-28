# Go-live checklist

Finish these before storing real patient data. Tick each and keep the evidence with your
compliance records.

## Hosting and configuration
- [ ] Hosting provider, database, storage and backup locations covered by BAAs ([baa-checklist.md](baa-checklist.md)).
- [ ] Disks encrypted (database volume, file volume, backup storage).
- [ ] `ENVIRONMENT=production`, strong `SECRET_KEY`, `DATA_ENCRYPTION_KEYS` set and stored in a
      secrets manager, with an escrow copy kept separately from the backups.
- [ ] HTTPS via the bundled Caddy (HSTS on) or an equivalent proxy; `FRONTEND_URL` is https.
- [ ] Managed database connections use `sslmode=require` or `verify-full`.
- [ ] SMTP over TLS with a provider that signs a BAA; SPF/DKIM/DMARC set for your sending domain.
- [ ] `FORWARDED_ALLOW_IPS` limited to your proxy.
- [ ] Only the proxy is reachable from the internet (database, API, worker on a private network).
- [ ] OS and container images patched; automatic security updates or a monthly patch window.

## Accounts and access
- [ ] "Require two-factor authentication" on for staff (Settings → Security).
- [ ] Idle timeout set (30 minutes or less).
- [ ] Each person has their own account with the narrowest role; owners limited to those who
      need it.
- [ ] Break-glass policy written and understood; owners review emergency access.
- [ ] Registration disabled (`ALLOW_REGISTRATION=false`) once your practice exists, unless you host
      multiple practices on purpose.

## Backups and recovery
- [ ] `admin backup` scheduled daily to off-site storage, encrypted to at least two age recipients
      held by different people.
- [ ] `admin restore-test` passes; scheduled at least quarterly; recovery within 72 hours
      rehearsed.
- [ ] Downtime procedure (paper schedule/contacts) documented.

## Monitoring
- [ ] Security events alerting reaches an owner or security officer.
- [ ] `admin audit-verify` runs nightly (worker job) and failures are investigated.
- [ ] Weekly activity-log review scheduled.
- [ ] Vulnerability scans every 6 months and a yearly penetration test planned.

## Paperwork
- [ ] Risk analysis completed ([risk-analysis-template.md](risk-analysis-template.md)).
- [ ] Policies adopted ([policies/](policies/)) and staff trained.
- [ ] Notice of Privacy Practices published; right-to-a-Good-Faith-Estimate notice posted.
- [ ] Consent and intake forms reviewed for your state (Forms library).
