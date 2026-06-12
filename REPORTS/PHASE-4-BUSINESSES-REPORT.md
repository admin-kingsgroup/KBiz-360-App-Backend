# PHASE 4 — BUSINESSES / ORG MODULE
**Project:** KBiz360 Smart Connect — backend migration
**Status:** ✅ **Complete & fully verified (live DB).** TypeScript green; **14 suites / 82 tests, 0 skips**. The 6 businesses-integration tests reproduce `homeSegments.test.ts` access filtering over HTTP and ran green against migrated + seeded Postgres.
**Date:** 2026-06-10
**Stack:** Node.js + Express + TypeScript + Prisma + PostgreSQL.

---

## 0. Scope
Read-only org hierarchy with access filtering: `GET /businesses`, `/businesses/:id`, `/businesses/:id/branches`, `/branches/:id/groups`, `/groups/:id/departments` — all enforced via the verbatim `makeAccessFilters` (`bizOK/brOK/grpOK/deptOK`).

## 1. Files created
- `src/modules/businesses/businesses.service.ts` — list/get with `makeAccessFilters`; maps Prisma rows → frontend shapes; display order from the canonical reference arrays.
- `src/modules/businesses/businesses.router.ts` — the 5 routes + per-request access resolution.
- `src/modules/businesses/__tests__/businesses.integration.test.ts` — 6 supertest tests (HTTP mirror of `homeSegments.test.ts`).

## 2. Files modified
- `src/app.ts` — mounted `businessRouter` at `/api` (serves `/businesses`, `/branches`, `/groups`).
- **Frontend: untouched.** No schema change.

## 3. Architecture changes
- New **read-only Businesses module**. Visibility flows ONLY through `makeAccessFilters` (no ad-hoc filtering) — `bizOK` (businesses), `brOK` (branches), `grpOK(branch.code, group.name)` (groups), `deptOK(branch.code, dept.name)` (departments).
- **Display order** is taken from the same `src/domain/data` reference arrays the seed used (businesses `tk,qa,…`; branch & group order per source) — the DB rows are sorted by that canonical index, so list order matches the app.

## 4. DB changes
- **None.** Reads existing `Business`/`Branch`/`Group`/`Department` tables.

## 5. API changes
| Method | Path | Filter | Out-of-scope | Missing |
|---|---|---|---|---|
| GET | `/api/businesses` | `bizOK` | (filtered out) | — |
| GET | `/api/businesses/:id` | `bizOK` | 403 | 404 |
| GET | `/api/businesses/:id/branches` | `bizOK` + `brOK` | 403 | 404 |
| GET | `/api/branches/:id/groups` | `brOK` + `grpOK` | 403 | 404 |
| GET | `/api/groups/:id/departments` | `brOK` + `deptOK` | 403 | 404 |

All require a Bearer token. Responses use the frontend shapes (`Business.branches` = branch count; branch geo fields included; groups/depts as `{id,name,icon,color}`).

## 6. Test results (LIVE)
- `npx jest` → **14 suites / 82 tests PASS, 0 skips** (Postgres up + seeded).
- New **businesses-integration (6, all asserted live):**
  - `GET /businesses`: Super → 7 (order starts `tk`); Employee(Rohan) → `['tk']`.
  - `GET /businesses/tk/branches`: Super → `['AMD','BOM','NBO']`; Rohan → `['AMD']`.
  - `GET /branches/amd/groups`: Super → 5; Rohan → `['Ticketing']`.
  - `GET /groups/amd-tkt/departments`: Super → 5; HOD(Harshit) → `['Ticketing']`.
  - `GET /businesses/qa`: Rohan → 403; Super → 200.
  - `GET /businesses` no auth → 401.
- These match `homeSegments.test.ts` (counts 15 groups = 3×5 for Super; employee Ticketing-only; HOD dept scoping) exactly, now proven over the API.

## 7. TypeScript results
- `npx tsc --noEmit` → **exit 0, 0 errors** ✅.

## 8. Risks
- **R12 — `/groups/:id/departments` route shape.** Departments are business-owned but **branch-scoped in the UI**. The brief's route nests them under a group, so the group resolves to its branch and departments are filtered by `deptOK(branch.code, name)`. Any group in a branch yields that branch's visible departments. (A `/branches/:id/departments` alias could be added if preferred.)
- **R13 — display order depends on `src/domain/data` arrays** (reference data) rather than a DB `sortOrder` column. Faithful and zero-migration; if the org becomes dynamic, add a `sortOrder` column.
- **R10** (users list not access-scoped) stands. **R1 resolved.**

## 9. Discovered inconsistencies
- None new. Access-filter behavior matches `homeSegments.test.ts` exactly.

## 10. Recommended next phase
**Phase 5 — Reminders.** `GET /reminders` (visibility via `makeCanSee` over the ReminderViewer space), `POST/PATCH/DELETE`, grouping via `groupReminders`, and the complete/approve state machine (self→approved, other→review, approve→approved). Reproduce `canSee.test.ts` + `reminderGrouping.test.ts` + `remindersStore.test.ts` over the API. DB is up — build + live-verify in one pass.

### ✅ Gate cleared
Live-verified end-to-end. No STOP conditions triggered (visibility filtering identical to source; no schema/behavior changes).
