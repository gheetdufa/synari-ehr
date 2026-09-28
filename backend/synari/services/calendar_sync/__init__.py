"""Calendar sync with Google Calendar and Microsoft Outlook/365.

- `providers.py`, `google.py`, `microsoft.py`: HTTP clients for each provider's OAuth and
  calendar APIs.
- `oauth.py`: connecting an account (PKCE, signed state, scope checks).
- `connections.py`: access tokens, connection health and the reconnect notice.
- `hooks.py`: `appointment_changed` queues an appointment's events for (re)sync or removal.
- `push.py`: the worker job that writes PHI-free events into each clinician's Synari calendar.
- `busy.py`: the worker job that polls busy times, and the lookups availability and scheduling
  use.
"""
