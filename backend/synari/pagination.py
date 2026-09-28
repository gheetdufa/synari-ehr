"""Offset pagination for list endpoints.

A paginated route takes a `Page` (the `limit` and `offset` query parameters) and runs its
query through `paginate`, which sets the `X-Total-Count` response header to the number of
rows matching the filters and limits the query to the page:

    def list_things(page: ListPage, response: Response, ...):
        return db.scalars(paginate(db, query.order_by(...), page, response)).all()
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, Query, Response
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

TOTAL_COUNT_HEADER = "X-Total-Count"


@dataclass(frozen=True)
class Page:
    """The slice of a list a request asks for."""

    limit: int
    offset: int


def page_params(default_limit: int, max_limit: int) -> Callable[..., Page]:
    """A dependency reading `limit` (1 to max_limit) and `offset` from the query string."""

    def dependency(
        limit: int = Query(default_limit, ge=1, le=max_limit, description="Rows per page"),
        offset: int = Query(0, ge=0, description="Rows to skip"),
    ) -> Page:
        return Page(limit=limit, offset=offset)

    return dependency


# Record lists (clients, invoices, notes...) and work queues whose rows are picked in bulk.
ListPage = Annotated[Page, Depends(page_params(default_limit=50, max_limit=200))]
QueuePage = Annotated[Page, Depends(page_params(default_limit=100, max_limit=500))]


def count_rows(db: Session, query: Select[Any]) -> int:
    """How many rows a query returns."""
    return db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0


def paginate[T: Select[Any]](db: Session, query: T, page: Page, response: Response) -> T:
    """Report the query's row count in X-Total-Count and return it limited to the page.

    The query must have a total order (end its ORDER BY with a unique column) so pages don't
    overlap.
    """
    response.headers[TOTAL_COUNT_HEADER] = str(count_rows(db, query))
    return query.limit(page.limit).offset(page.offset)
