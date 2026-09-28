"""Insurance claims engine: professional claims out, acknowledgments and payments back.

This package has no database or settings dependencies. Everything is plain frozen dataclasses,
so callers map their own records in and store the results however they like.

Data flow:

1. `document`: build a `ClaimDocument` (billing provider, subscriber, payer, optional patient,
   claim lines, optional coordination-of-benefits data).
2. `validate`: `validate_claim(document)` lists every problem in plain English before anything
   is sent.
3. Send it one of three ways:
   - `x12_837p`: `build_837p(documents, envelope, submitter, receiver)` writes an X12 5010
     837P file for any clearinghouse (SFTP upload).
   - `stedi`: `StediClient.submit_claim(document)` sends it to Stedi's JSON claims API.
   - `cms1500`: `cms1500_pdf(documents)` prints it onto the red CMS-1500 paper form.
4. Read what comes back into the dataclasses in `responses`, whichever path it took:
   - `x12_parse`: `parse_999` (file accepted?), `parse_277ca` (each claim accepted or rejected
     by the payer) and `parse_835` (remittances: payments, adjustments, reversals).
   - `stedi`: `StediClient.list_new_reports()` returns the same acknowledgment and remittance
     dataclasses from Stedi's JSON reports; `check_eligibility` and `search_payers` help before
     a claim is ever sent.
"""
