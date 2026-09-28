"""Finding clients by what staff type into a search box (client lists, pickers, the inbox)."""

import re

from sqlalchemy import ColumnElement, func, or_

from synari.models import Client

# Searches with at least this many digits also match phone numbers by their digits alone.
MIN_PHONE_DIGITS = 3


def client_matches(term: str) -> ColumnElement[bool]:
    """SQL condition on `Client`: their name, email or phone contains `term` (any case).

    A term with three or more digits also matches phone numbers written with other
    punctuation (e.g. "3125550101" finds "(312) 555-0101").
    """
    matches = [
        Client.first_name.icontains(term, autoescape=True),
        Client.last_name.icontains(term, autoescape=True),
        Client.preferred_name.icontains(term, autoescape=True),
        (Client.first_name + " " + Client.last_name).icontains(term, autoescape=True),
        Client.email.icontains(term, autoescape=True),
        Client.phone.icontains(term, autoescape=True),
    ]
    digits = re.sub(r"\D", "", term)
    if len(digits) >= MIN_PHONE_DIGITS:
        phone_digits = func.regexp_replace(Client.phone, r"\D", "", "g")
        matches.append(phone_digits.contains(digits, autoescape=True))
    return or_(*matches)
