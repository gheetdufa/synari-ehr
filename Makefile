.PHONY: services api worker web migrate fmt lint test check

BACKEND_PATHS = synari tests migrations perf

## Local development
services:  ## Start Postgres, Mailpit and the LiveKit dev server
	docker compose up -d db mailpit livekit

api:  ## Run the API with auto-reload on :8000
	cd backend && uv run uvicorn synari.main:app --reload --port 8000 --no-access-log

worker:  ## Run the background worker (email/SMS, reminders, invoices, AutoPay)
	cd backend && uv run python -m synari.worker

web:  ## Run the web app on :5173
	cd frontend && npm run dev

migrate:  ## Apply database migrations
	cd backend && uv run alembic upgrade head

## Quality gates
fmt:
	cd backend && uv run ruff format $(BACKEND_PATHS) && uv run ruff check --fix $(BACKEND_PATHS)
	cd frontend && npx eslint --fix .

lint:
	cd backend && uv run ruff format --check $(BACKEND_PATHS) && uv run ruff check $(BACKEND_PATHS)
	cd backend && uv run alembic check
	cd frontend && npm run lint && npx tsc --noEmit -p tsconfig.app.json

test:
	cd backend && uv run pytest -q
	cd frontend && npm run test --if-present

check: lint test
