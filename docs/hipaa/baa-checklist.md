# Business Associate Agreements

Sign a BAA with every vendor that creates, receives, maintains or transmits PHI for you before
you send it any real patient data. Record the signed date and where the agreement is kept.

| Vendor type | Your vendor | BAA signed (date) | Notes |
|---|---|---|---|
| Server / cloud hosting | | | Must cover the servers running Synari |
| Managed Postgres (if used) | | | |
| File storage / S3 (if used) | | | Enable default encryption and versioning |
| Backup storage | | | Off-site, encrypted, access-logged |
| Email delivery (SMTP) | | | Content-free messages still identify clients |
| SMS (Twilio or other) | | | Eligible plan required |
| Insurance clearinghouse (Stedi or other) | | | |
| Video (LiveKit Cloud, if used) | | | Not needed if self-hosted on your own servers |
| AI provider (if enabled) | | | Leave AI off without one |
| Google Workspace / Microsoft 365 (if calendar sync is used) | | | Consumer Gmail/Outlook.com accounts are not covered |
| Error monitoring / logging (if used) | | | Synari logs avoid PHI, but treat logs as sensitive |
| Payment processor | | | Usually exempt for payment processing; document your conclusion |

Also: keep a copy of each vendor's security attestation (SOC 2 report or HITRUST letter) and
review vendors yearly.
