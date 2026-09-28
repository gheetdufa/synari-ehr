# Contingency plan

**Owner:** [Security officer] · **Reviewed:** [date]

## Data backup
- `python -m synari.admin backup` runs [daily at 02:00] (compose `backup` service or cron),
  encrypting the database dump and files with age to [two] recipients held by [names], writing to
  [off-site location] with versioning, keeping [30 daily / 12 monthly] copies.
- `DATA_ENCRYPTION_KEYS`, `SECRET_KEY` and the age private keys are escrowed in [location],
  separate from the backups. Without them backups can't be read.

## Restore testing
- `python -m synari.admin restore-test` runs [monthly] and after any change to backup settings. It
  restores into a throwaway database, checks the schema, record counts and the audit chain, and
  decrypts sample records and files. Target: full restore within 72 hours.

## Disaster recovery
1. Provision a new server from `deploy/` with the escrowed secrets.
2. Restore the latest good backup; verify with `admin restore-test` and `admin audit-verify`.
3. Point DNS at the new server; confirm sign-in, calendar and messaging.

## Emergency mode operations
While Synari is unavailable, clinicians use [printed daily schedule / contact list], document on
[paper forms], and enter records afterwards. [Name] decides when to invoke emergency mode.

## Testing and revision
Exercise this plan yearly and update it after changes.
