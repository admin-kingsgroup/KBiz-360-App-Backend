# KBiz360 Smart Connect — Backend

Production backend for the KBiz360 React Native app. **Node.js + Express + TypeScript · Prisma · PostgreSQL · Socket.IO · BullMQ/Redis.** It reproduces the frontend's behavior exactly — the canonical business logic is lifted **verbatim** into `src/domain/` and verified by the same tests.

## Quick start
```bash
cp .env.example .env                 # adjust if needed (defaults work with the compose file)
npm install
docker compose up -d                 # Postgres (5432) + Redis (6379)
npm run prisma:deploy                # apply migrations
npm run db:seed                      # load all mock data + dev users (dev only)
npm test                             # 122 tests (needs DB + Redis up)
npm run start:dev                    # API + Socket.IO on :4000
```
Dev login: `afshin@kbiz360.com` / `kbiz360` (every seeded user uses `kbiz360`).

## Scripts
`build` · `start` · `start:dev` · `typecheck` · `test` · `test:cov` · `prisma:migrate` · `prisma:deploy` · `db:seed`

## Layout
- `src/domain/` — verbatim port of `Frontend/src/{types,constants,logic,data}` (**locked** — see `src/domain/README.md`).
- `src/modules/` — auth, access, users, businesses, reminders, attendance, chats, notifications, uploads, audit, health.
- `src/{config,db,common,realtime,queue,storage}/` — infrastructure.
- `prisma/` — `schema.prisma`, migrations, `seed.ts`.

## Docs
Phase-by-phase reports and the **API + Socket.IO specs, security/ops checklist, and risk register** are in [`REPORTS/`](REPORTS/) — start with `PHASE-11-PRODUCTION-READINESS.md`.

> **Note:** the dev seed sets a shared password and the JWT secrets are placeholders — see `REPORTS/PHASE-11-PRODUCTION-READINESS.md` §5 before deploying.
