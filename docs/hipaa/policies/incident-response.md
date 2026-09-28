# Security incident and breach response policy

**Owner:** [Security officer] · **Reviewed:** [date]

## Report
Anyone who suspects a security incident (lost device, phishing, wrong recipient, unusual access,
ransomware, a vendor notice) reports it immediately to [security officer contact].

## Respond
1. **Contain:** deactivate or reset affected accounts, revoke sessions (Settings → Team /
   Security), rotate exposed secrets, isolate affected systems.
2. **Scope:** use the client access history, activity-log export and security events to find
   which records and clients were involved and by whom. Verify the audit chain.
3. **Preserve evidence:** export relevant audit logs and system logs; don't wipe systems before
   evidence is captured.
4. **Recover:** restore from backups if needed (contingency plan).

## Breach assessment (45 CFR 164.402)
An impermissible use or disclosure of PHI is presumed a breach unless a documented assessment
shows a low probability of compromise, considering:
1. the nature and extent of the PHI (identifiers, sensitivity, likelihood of re-identification);
2. the unauthorized person who used or received it;
3. whether the PHI was actually acquired or viewed;
4. how far the risk has been mitigated.
PHI encrypted in line with HHS guidance (for example Synari's encrypted columns and files, when the
keys weren't also exposed) is not "unsecured" and may fall under the safe harbor.

## Notify (164.404–408)
If it's a breach of unsecured PHI:
- **Individuals:** without unreasonable delay and within 60 days of discovery, in writing.
- **HHS:** within 60 days if 500 or more people are affected; otherwise in the annual log within
  60 days after the end of the calendar year.
- **Media:** if more than 500 residents of a state or jurisdiction are affected.
- **Covered entity:** if you operate Synari as a business associate, notify the covered entity as
  your BAA requires.
Also check state breach laws, which may be stricter.

## Document
Keep incident records, assessments and notifications for six years.
