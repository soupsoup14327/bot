Generated Drizzle SQL migrations live here.

- `sqlite/` is the runtime migration pack for the current dev/test path.
- `postgres/` is the generated pack for Postgres parity and future CI/prod use.

Each backend keeps its own `meta/` journal/snapshots. Those generated files
must stay committed together with SQL files so runtime migration state matches
the schema snapshot for that backend.

Current practical boundary:
- Runtime migrator picks `sqlite/` or `postgres/` based on `DATABASE_URL`.
- SQLite remains the primary dev/test backend and the path exercised by the
  default local workflow today.
- Postgres now has its own generated SQL/journal pack, but PG CI/advisory-lock
  hardening remains a separate follow-up.
- `npm run db:generate:pg` falls back to
  `postgres://postgres:postgres@127.0.0.1:5432/pawpaw_dev` when
  `DATABASE_URL` is unset; real PG environments should always set
  `DATABASE_URL` explicitly.
- After any schema change, run `npm run db:generate` so SQLite and Postgres
  packs stay in sync in one commit.
