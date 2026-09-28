# Audit log review procedure

**Owner:** [Security officer] · **Frequency:** weekly, plus on every security alert.

Synari records sign-ins and every view or change of client records, seals them into a hash chain
and keeps them at least six years.

Weekly, the reviewer:
1. Opens Settings → Security → Security events and resolves each new event (lockouts, 2FA
   changes, new-device sign-ins, token reuse, emergency access, exports, role changes, unusual
   access volume, backup or audit-verification problems).
2. Reviews the activity log for the week, filtered by: exports; emergency access; staff opening
   records of clients not on their care team; sign-ins at unusual times or places; changes to
   signed notes.
3. Spot-checks access history for [5] clients chosen at random, including any VIP or staff-member
   clients.
4. Confirms the nightly audit-chain verification passed (`python -m synari.admin audit-verify`).
5. Records the review (date, reviewer, findings, follow-up) in [the review log].

Anything suspicious is handled under the incident response policy.
