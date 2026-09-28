# Contributing to Synari

Thanks for helping build open practice-management software for therapists.

## Getting set up

Follow the quick start in [README.md](README.md). Then read the conventions for the part
you're changing: [backend/README.md](backend/README.md) and
[frontend/README.md](frontend/README.md).

## Before you open a pull request

```bash
make fmt     # format and auto-fix
make lint    # ruff, alembic drift check, eslint, TypeScript
make test    # pytest (needs `make services`) and vitest
```

CI runs the same checks plus a secret scan; all of them must pass.

- **Keep changes focused.** One feature or fix per pull request, with tests.
- **Database changes** need an Alembic migration (`uv run alembic revision --autogenerate`),
  reviewed by hand.
- **Protect client data.** Scope every query to the owning therapist or client, audit access
  to clinical data, and never put clinical content in emails, texts, URLs or logs.
- **Never commit secrets or real patient data**, including in tests, screenshots and issue
  reports. Use obviously fake data.
- **UI changes** should work on phones and with a keyboard, and include a screenshot in the
  pull request.

## Reporting bugs and ideas

Open an issue with steps to reproduce, what you expected, and what happened. Security
problems go through [SECURITY.md](SECURITY.md) instead.

## License

By contributing you agree that your contributions are licensed under the
[GNU AGPL-3.0](LICENSE).
