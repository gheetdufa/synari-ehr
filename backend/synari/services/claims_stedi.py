"""The configured Stedi clearinghouse account.

Call `claims_stedi.stedi_client()` through the module (not a copied name) so tests can swap
in a client with an httpx.MockTransport.
"""

from fastapi import HTTPException, status

from synari.claims.stedi import StediClient
from synari.config import settings

NOT_CONFIGURED = (
    "No clearinghouse is connected. Add a Stedi API key (STEDI_API_KEY) to the server's "
    "settings, or download 837P files or CMS-1500 forms instead."
)


def stedi_client() -> StediClient:
    """A client for the server's Stedi account; close it after use (it's a context manager)."""
    return StediClient(settings.stedi_api_key, settings.stedi_base_url)


def require_stedi() -> None:
    """409 when no Stedi account is configured."""
    if not settings.stedi_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, NOT_CONFIGURED)
