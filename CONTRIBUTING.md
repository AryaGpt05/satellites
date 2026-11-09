# Contributing

Thanks for your interest. Issues and pull requests are welcome.

## Setup

You need Node 22 or newer.

```bash
npm install
```

```bash
npm run dev
```

The app runs fully without a backend: lookups, shares and stats switch off when the Supabase variables are unset.
To work on those, see [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

## Before you open a pull request

Run all three checks and make sure they pass:

```bash
npx tsc -b
```

```bash
npx vitest run
```

```bash
npx vitest run --config scripts/backend-vitest.config.ts
```

- Keep changes focused, one topic per pull request.
- Add or update tests for behaviour you change.
- `docs/ARCHITECTURE.md` describes the contracts between modules; `docs/DESIGN.md` describes the visual design.
- Never commit secrets, `.env*` files (other than `.env.example`), or personal email addresses. Admins are set
  per deployment with `scripts/backend-set-admin.sh`, not in migrations.
- Don't run the `scripts/backend-*.sh` scripts against a database you don't own.

By contributing, you agree your contribution is licensed under the project's [MIT license](LICENSE).

## Security issues

Please don't file those as issues. See [`SECURITY.md`](SECURITY.md).
