"""Importing a practice from SimplePractice.

- `fields`: the files the importer understands, their columns and header aliases.
- `values`: parsing names, dates, money, phones and statuses from report cells.
- `tables`: reading CSV and XLSX reports.
- `vcard`: reading the Complete export's contact cards.
- `sources`: storing uploads in chunks and the zip password.
- `archive`: reading the Complete export zip.
- `plan`: turning the files into clients, sessions, documents and balances, and the preview.
- `runner`: creating the records, resumably.
- `jobs`: the worker jobs that analyze and run imports.
"""


class ImportFailed(Exception):
    """A problem with the uploaded files, explained so the practice can fix it."""
