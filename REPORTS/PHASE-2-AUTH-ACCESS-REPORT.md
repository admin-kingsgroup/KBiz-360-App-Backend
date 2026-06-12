# PHASE 2 — AUTH + ACCESS SERVICE
**Project:** KBiz360 Smart Connect — backend migration
**Status:** ✅ **Complete & fully verified, including live DB.** TypeScript green; all assertions green. The 7-test auth-integration suite **ran green against live Postgres** (migrate + seed applied). Gate cleared.
**Date:** 2026-06-10
**Stack:** Node.js + Express + TypeScript + Prisma + PostgreSQL (JWT via `jsonwebtoken`, hashing via `bcryptjs`).

---

## 0. Scope
Implement authentication (`/auth/login|refresh|logout|me`) with JWT access+refresh and refresh-token storage, and the centralized `AccessService` that reproduces `deriveAccess`/`makeAccessFilters`/`makeCanSee` exactly. No schema changes; no other feature endpoints.

## 1. Files created
- `src/modules/access/access.service.ts` — **AccessService** + `toDomainUser` (Prisma row → frontend `User` shape).
- `src/modules/access/__tests__/accessService.test.ts` — 3 unit tests (no DB).
- `src/modules/auth/jwt.ts` — sign/verify access + refresh, typed claims.
- `src/modules/auth/auth.service.ts` — login / me / refresh (rotation) / logout (revocation).
- `src/modules/auth/auth.middleware.ts` — `requireAuth` (Bearer → `req.auth`).
- `src/modules/auth/auth.router.ts` — routes + zod schemas.
- `src/modules/auth/__tests__/auth.integration.test.ts` — 7 supertest tests (self-skip without DB).
- `src/common/audit.ts` — `writeAudit()` append-only writer.
- `src/types/express.d.ts` — augments `Express.Request` with `auth`.

## 2. Files modified
- `src/app.ts` — mounted `/api/auth`.
- `prisma/seed.ts` — sets `passwordHash` (dev password `kbiz360`, bcrypt) on all seeded users.
- `package.json` — added `jsonwebtoken`, `bcryptjs`; dev `supertest`, `@types/jsonwebtoken`, `@types/supertest`; **removed `@types/bcryptjs`** (bcryptjs v3 ships its own types — would conflict).
- **Frontend: untouched.**

## 3. Architecture changes
- **`AccessService` is the single access authority.** It only *wraps* the verbatim ported pure functions — `accessForUser`/`accessForUserId` → `deriveAccess`; `filtersForUser` → `makeAccessFilters`; `personMeta`/`canSeeFor` → `makeCanSee`. **No rules reimplemented** (RULE #1/#2). It reads the two identity spaces from their own tables (`User`, `ReminderViewer`).
- **Auth:** stateless JWT **access** token + JWT **refresh** token; the refresh token is stored **hashed (sha256)** in `RefreshToken` with `expiresAt`. **Rotation** on refresh (old revoked, new issued); **revocation** on logout; reuse of a revoked/expired token → 401.
- **Audit:** `LOGIN`/`LOGOUT`/`REFRESH` rows written via `writeAudit` (foundation for the per-mutation audit requirement).

## 4. DB changes
- **No schema change.** Existing `RefreshToken` + `AuditLog` tables are now exercised.
- **Seed change:** every seeded user gets `passwordHash = bcrypt('kbiz360')` so login works in dev (R7).

## 5. API changes (live in Express)
| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/api/auth/login` | — | `{ identifier, password }` | `{ accessToken, refreshToken, user, access }` |
| POST | `/api/auth/refresh` | — | `{ refreshToken }` | `{ accessToken, refreshToken }` (rotated) |
| POST | `/api/auth/logout` | — | `{ refreshToken }` | `204` (idempotent revoke) |
| GET | `/api/auth/me` | Bearer | — | `{ user, access }` (derived AccessControl) |

- `identifier` matches **email OR legacyAdminId OR canonical id** (accommodates the frontend's free-form "User ID" field). Dev login: `afshin@kbiz360.com` / `kbiz360`.

## 6. Test results
- `npx jest` → **all green** (TypeScript-compiled via ts-jest).
  - 53 ported-domain (Phase 1) + **3 new AccessService unit** + **7 auth-integration** = all asserting, all green.
  - **LIVE RUN (Postgres up + migrated + seeded):** the 7 auth-integration tests **ran for real (0 skips):** login → 200 + super access; wrong password → 401; `/me` with token; `/me` without token → 401; refresh rotates + old token revoked (reuse → 401); logout → 204 + revoked; malformed token → 401.
- Frontend: untouched → still 76/76.

## 7. TypeScript results
- `npx tsc --noEmit` → **exit 0, 0 errors** ✅ (strict). `prisma generate` ✅.

## 8. Risks
- **R1 — RESOLVED.** Postgres (docker) is up; `prisma migrate deploy` + `db:seed` applied; the 7 integration assertions ran green live.
- **R7 — shared dev password.** All seeded users authenticate with `kbiz360`. Dev-only; production seed must set per-user secrets / disable.
- **R8 — bcryptjs v3 self-types** (removed `@types/bcryptjs`); imported as `import * as bcrypt`.
- **R9 — broad login identifier match** (email/legacyAdminId/id) is intentional for the frontend's "User ID" field; tighten if you want email-only.
- **R2–R6** from Phase 1 stand.

## 9. Discovered inconsistencies / intended behavior changes
- **Intended change (not a STOP condition): real auth replaces simulated login.** The frontend login is fully simulated (any input → Afshin). The backend now requires valid credentials. This is the explicit migration goal (`Frontend/CLAUDE.md`: auth is `[NEEDS BACKEND]`, "replace the simulated login with token-based sign-in"). The **gate logic itself is unchanged** (`resolveGate`/`allPermsGranted` ported verbatim and green). Wiring the frontend login screen to `/api/auth/login` happens in the Frontend-integration phase; no access/reminder/attendance/chat behavior changed.
- No new data inconsistencies.

## 10. Recommended next phase

**Phase 3 — Users module.** `GET/POST/PATCH/DELETE /api/users` enforcing:
- `validateUserDraft` (verbatim) for create/edit,
- access scoping + `canManage` via `AccessService` (a Director/Super can manage; others 403),
- audit on every mutation (CREATE/UPDATE/DELETE User),
- integration tests reproducing `adminUsers.test.ts` + `validation.test.ts` behavior over the API.

### ✅ Gate cleared
Postgres was brought up; migration + seed applied; all 7 integration assertions ran green. Phase 2 is fully proven. No STOP conditions triggered.
