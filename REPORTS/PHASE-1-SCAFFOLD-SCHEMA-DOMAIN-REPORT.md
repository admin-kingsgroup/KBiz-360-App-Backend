# PHASE 1 — BACKEND SCAFFOLD + PRISMA SCHEMA + DOMAIN PORT
**Project:** KBiz360 Smart Connect — backend migration
**Status:** ✅ Complete & verified (TypeScript green, 53/53 ported domain tests green, schema validates, baseline migration DDL generated). Live-DB apply deferred (see Risks R1).
**Date:** 2026-06-10
**Stack (revised per user):** **Node.js + Express + TypeScript** + Prisma + PostgreSQL (was NestJS in the brief — see Architecture §3 / Risk R5).

---

## 0. Scope of this phase
Foundation only — **no feature endpoints**. Stand up the project, lift the canonical business logic **verbatim**, author the **complete Prisma schema** (approved separate-identity model), write the **seed** that reproduces every mock dataset, and prove behavior parity with the existing tests. Auth/users/reminders/etc. are Phase 2+.

---

## 1. Files created

**Project root / tooling**
- `Backend/package.json`, `package-lock.json` — Express+TS+Prisma deps (427 pkgs installed).
- `Backend/tsconfig.json`, `tsconfig.build.json`, `tsconfig.jest.json`, `jest.config.js`
- `Backend/.gitignore`, `.env.example`, `.env` (local, gitignored), `docker-compose.yml` (postgres+redis)

**App scaffold (`Backend/src/`)**
- `main.ts` — entrypoint: Express + Socket.IO on one HTTP server, DB connect, graceful shutdown.
- `app.ts` — Express app factory; helmet/cors/json; `/health`; feature routers stubbed for Phase 2+.
- `config/index.ts` — typed env config (db, jwt, redis, storage).
- `db/prisma.ts` — shared `PrismaClient` singleton + connect/disconnect.
- `common/errors.ts` — `AppError` + zod-aware central error handler.
- `common/asyncHandler.ts`, `common/validate.ts` — async wrapper + zod request-validation middleware.
- `modules/health/health.router.ts` — `GET /health` (liveness), `GET /health/ready` (DB ping).
- `realtime/socket.ts` — Socket.IO server + event contract (`message:new/read`, `chat:typing`), idle.
- `queue/index.ts` — BullMQ connection + queue names (`push-delivery`, `email-delivery`), lazy.

**Domain (verbatim port — `Backend/src/domain/`)** — 40 files copied byte-for-byte from `Frontend/src/*`:
- `types/*` (10), `constants/*` (6), `logic/*` (8), `data/*` (6), `theme/colors.ts`, `services/notifications/routes.ts`.
- `navigation/guards.ts` — **pure subset** (`resolveGate`,`allPermsGranted` verbatim; React/Zustand `useGate` omitted).
- `__tests__/*` (9 ported pure-logic specs), `README.md` (provenance + re-sync policy).

**Database (`Backend/prisma/`)**
- `schema.prisma` — 19 models, 6 enums, 18 FKs (full schema below).
- `seed.ts` — reproduces every `src/data/*` dataset; applies approved identity-link rules.
- `migrations/0_init/migration.sql` — baseline DDL (414 lines) generated from schema (no DB needed).
- `migrations/migration_lock.toml`.

**Reports**
- `REPORTS/PHASE-1-SCAFFOLD-SCHEMA-DOMAIN-REPORT.md` (this file). (`PHASE-0-FOUNDATION-REPORT.md` was Phase 0.)

## 2. Files modified
- **None in `Frontend/`** — the frontend was not touched (RULE #2; verified: source mtimes unchanged). All porting was copy-only.
- Transient: an initial NestJS scaffold (`package.json`, `src/config/configuration.ts`, `src/prisma/prisma.service.ts`) was created then **removed/replaced** with Express when you chose Node.js/Express mid-phase. No NestJS artifacts remain (`grep @nestjs src` → none).

## 3. Architecture changes
- New **Express + TypeScript** backend under `Backend/`. Layering mirrors the frontend's discipline: **`domain/` (verbatim, locked) → services (Phase 2+) → routers → http**.
- **`domain/` is the source-of-truth copy**: `AccessService` and friends will *wrap* `deriveAccess`/`makeAccessFilters`/`makeCanSee` — no rewrites (RULE #1/#2).
- **Socket.IO** attached to the same HTTP server (handlers Phase: Chat). **BullMQ/Redis** wired but lazy (no socket opened until a queue is used) — push/email delivery in the Notifications phase.
- **Deviations from the original brief (both user-directed / idiomatic):**
  - **R5:** Express instead of NestJS (your decision).
  - **R4:** **zod** for request validation instead of class-validator/class-transformer (idiomatic for Express; the *business* validation `validateUserDraft` is still the verbatim ported logic).

## 4. DB changes
- **New Prisma schema — 19 tables, 6 enums, 18 FK constraints.**
  - Enums: `RoleKey`, `BizStatus`, `ModuleKey`, `ReminderState (pending|review|approved)`, `ChatKind`, `MessageStatus`.
  - Tables: `Role, Business, Branch, Group, Department, AlertChannel, AlertEvent, User, ReminderViewer, Reminder, Chat, ChatParticipant, Message, AttendanceRecord, Notification, Device, RefreshToken, Upload, AuditLog`.
- **Identity model (approved):** `User` (access space) and `ReminderViewer` (canSee space) are **separate**, linked 1:1 via nullable `ReminderViewer.userId`. `ReminderViewer.role/branches/dept` are **stored, not derived** → `makeCanSee` output unchanged.
- **Access grants stored verbatim** as `String[]` of the exact composite ids (`'AMD-Accounts'`, `'AMD-crm'`, branch codes) → `deriveAccess` receives identical arrays.
- **Attendance** stores GPS (`latitude/longitude/distanceMeters`), Wi-Fi (`wifiSsid`), and `faceVerified` per the brief.
- **Baseline migration** `0_init/migration.sql` generated via `prisma migrate diff --from-empty` (offline). **Not yet applied to a live DB** (R1).
- **Seed** reproduces source counts exactly (verified by importing the data at runtime):

  | entity | count | entity | count |
  |---|---|---|---|
  | businesses | 7 | reminderViewers | 9 |
  | branches | 3 | reminders | 16 |
  | groups | 15 | chats | 7 |
  | departments | 5 | chatParticipants | 7 |
  | alertChannels | 35 | attendance (team) | 7 |
  | alertEvents | 15 | users | 8 |

  **Identity links applied by seed:** `a→User a1`, `fa→a2`, `p→a3` (confident); `f, m, r, sn, ko, an → UNLINKED` (Faiz role/surname divergence + orphans), exactly as the foundation report predicted.

## 5. API changes
- **Live:** `GET /health`, `GET /health/ready` (DB ping).
- **Stubbed (commented in `app.ts`) for later phases:** `/api/auth`, `/api/users`, `/api/businesses`, `/api/reminders`, `/api/attendance`, `/api/chats`, `/api/notifications`, `/api/uploads`, `/api/audit`.
- **Socket.IO** event contract declared (no handlers yet).
- No frontend API client changes (frontend integration is a later phase).

## 6. Test results
- **Backend (ported pure-domain):** `npx jest` → **9 suites / 53 tests PASS** ✅
  - `access` (8), `canSee` (6), `reminderGrouping` (5), `attendance` (13), `validation` (5), `notificationRouting` (5), `guards` (4), `homeSegments` (4), `chatList` (3).
  - These run the **identical assertions** as the frontend → proves access/canSee/reminder/attendance/validation behavior is reproduced exactly in the backend.
- **Deferred to their service phases (need Zustand→service reimplementation + a live DB):** the 7 store-integration suites (`stores`, `remindersStore`, `pulseStore`, `chatUnread`, `adminUsers`, `attendanceFlow`, `authFlow`) — will be re-proven as integration tests in Phases 2–6.
- **Frontend:** untouched → still **76/76** (last run this session before backend work).

## 7. TypeScript results
- **Backend:** `npx tsc --noEmit` → **exit 0, 0 errors** ✅ (strict mode; includes `prisma/seed.ts` + generated client).
- **Prisma:** `prisma validate` ✅, `prisma format` ✅, `prisma generate` ✅ (client v5.22).
- **Frontend:** still **RED** (D1 — pre-existing `useNotificationRouting.ts` typed-route error). Untouched by this phase.

## 8. Risks
- **R1 — Live DB apply not executed.** Docker daemon is not running (CLI only) and I won't force-launch Docker Desktop. Schema → DDL is generated & validated offline and the seed source resolves at runtime, but `migrate deploy` + `db:seed` against real Postgres is **deferred**. *Mitigation:* start `docker compose up -d postgres` (or supply a `DATABASE_URL`) and run `npm run prisma:migrate && npm run db:seed` — Phase 2 needs this anyway.
- **R2 — Grants stored as `String[]`, not normalized.** Deliberate, to guarantee `makeAccessFilters` parity. Future normalization must reconstruct the exact composite strings.
- **R3 — Partial identity links.** Only `a/fa/p` linked to Users; `f` + orphans unlinked by design. Any future feature that joins identities across spaces must handle `userId = null`.
- **R4 — zod instead of class-validator** (deviation from brief).
- **R5 — Express instead of NestJS** (your decision; brief said NestJS).
- **R6 — Chat unread is per-`ChatParticipant`** but the seed attributes all unread to the single signed-in viewer (`a1`), matching today's single-viewer `chatStore`. Multi-viewer unread is correct in the model and activates in the Chat phase.

## 9. Discovered inconsistencies
- **D2 (resolved in schema):** runtime reminder states are `pending|review|approved` (the foundation type's `'open'` is unused) → `ReminderState` enum uses the runtime values.
- No new inconsistencies surfaced. D1/D3/D4/D5 from Phase 0 stand (D1 frontend-only, untouched).

## 10. Recommended next phase

**Phase 2 — Auth + AccessService.**
1. **Prereq:** bring up Postgres (R1) and run the baseline migration + seed.
2. `AccessService` wrapping the ported `deriveAccess`/`makeAccessFilters`/`makeCanSee` (no rewrites) over Prisma `User`/`ReminderViewer` rows.
3. Endpoints: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` — JWT access+refresh, `RefreshToken` storage (hashed), auth middleware.
4. Add deps: `jsonwebtoken`, `bcrypt`, `passport`-style guard (or plain middleware), `@types/*`.
5. Integration tests (supertest) reproducing `authFlow.test.ts` + `stores.test.ts` access behavior against the API. Update test count + TS results in the Phase 2 report.

### ⛔ Awaiting go-ahead for Phase 2
No STOP conditions were triggered (no access/reminder/attendance/chat behavior changed; identity kept separate as approved). Confirm to proceed — and note whether you can start Docker/Postgres locally so Phase 2 can run live migrations + integration tests.
