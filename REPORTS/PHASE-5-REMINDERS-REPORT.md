# PHASE 5 — REMINDERS MODULE
**Project:** KBiz360 Smart Connect — backend migration
**Status:** ✅ **Complete & fully verified (live DB).** TypeScript green; **15 suites / 93 tests, 0 skips**. The 11 reminders-integration tests reproduce `canSee.test.ts` + `reminderGrouping.test.ts` + `remindersStore.test.ts` over HTTP and ran green against seeded Postgres.
**Date:** 2026-06-10
**Stack:** Node.js + Express + TypeScript + Prisma + PostgreSQL.

---

## 0. Scope
`GET /reminders` (tab filters + canSee visibility + grouping), `POST/PATCH/DELETE /reminders`, and the complete/approve state machine — all using the verbatim foundation logic (`applyCanSee`, `groupReminders`, and the `remindersStore` transitions). Operates in the **ReminderViewer (PERSON_META) identity space**.

## 1. Files created
- `src/modules/reminders/reminders.service.ts` — viewer resolution, tab filters, `applyCanSee`/`groupReminders`, create, complete/approve state machine, delete; audit on mutations.
- `src/modules/reminders/reminders.router.ts` — routes + zod schemas (`tab`/`viewAs` query, create, patch).
- `src/modules/reminders/__tests__/reminders.integration.test.ts` — 11 supertest tests.

## 2. Files modified
- `src/app.ts` — mounted `/api/reminders`.
- **Frontend: untouched.** No schema change.

## 3. Architecture changes
- New **Reminders module** in the reminder-space identity. The authed user's reminder id = the **linked `ReminderViewer`** (a1→`a`, a2→`fa`, a3→`p`), falling back to **`CURRENT_USER_ID` (`a`)** for unlinked users — mirroring the single-user frontend (`CURRENT_USER_ID = 'a'`).
- **Tab filters reproduced verbatim** from `RemindersScreen`:
  - `forme`: `pending && forId === current`
  - `iset`: `pending && byId === current && forId !== current`
  - `review`: `state==='review' && byId === current`
  - `all`: `applyCanSee(live, ROLE_VIEWERS[viewAs], personMeta)` — `live = state !== 'approved'`.
- **`viewAs` override is Super-only** (the role-preview picker shows for Super Admin only); other roles always use their real role.
- **Grouping** via `groupReminders` (All → person-wise by RANK then name; others → role-tier).
- **State machine** copied from `remindersStore`: complete → self-assigned `approved` ("archived") else `review`; approve → `approved`.
- `personMeta` is read from the DB (`ReminderViewer` rows via `AccessService`), not a hardcoded map.

## 4. DB changes
- **None.** Created reminders get id `r-<uuid>` (the `Reminder.id` has no DB default, matching the frontend's `r-${Date.now()}` scheme).

## 5. API changes
| Method | Path | Notes |
|---|---|---|
| GET | `/api/reminders?tab=forme\|iset\|review\|all&viewAs=ROLE` | returns `{ tab, isAll, reviewCount, viewer, groups, visible }` |
| POST | `/api/reminders` | `{ text, forId, when?, section? }` → 201; byId = current; display from viewer/user |
| PATCH | `/api/reminders/:id` | `{ action: 'complete'\|'approve' }` (state machine) or `{ text?, when?, section? }` edits |
| DELETE | `/api/reminders/:id` | creator (byId===current) or manager only; 204 |

All require a Bearer token.

## 6. Test results (LIVE)
- `npx jest` → **15 suites / 93 tests PASS, 0 skips**.
- New **reminders-integration (11, all live):**
  - All tab (Super) → person groups `['a','p','f','m','ko','r','sn']` (RANK then name); 14 items (16 seed − 2 approved).
  - All tab `viewAs=BRANCH_MANAGER` → `['f','m','r']` (AMD HOD/staff below; excludes GM/Super/other branches) — matches `canSee.test.ts`.
  - For me → 3 (role-tier, `SUPER_ADMIN`); I set → 4; Review → 2 (reviewCount 2).
  - POST → 201 (byId `a`, forName `Riya Patel`); complete other-assigned → `review`; complete self-assigned → `archived`/`approved`; approve → `approved`; DELETE → 204; no-auth → 401.

## 7. TypeScript results
- `npx tsc --noEmit` → **exit 0, 0 errors** ✅.

## 8. Risks
- **R14 — single-user reminder identity.** Tab filters key off the current user's reminder id (linked viewer or `a`), mirroring the frontend's `CURRENT_USER_ID`. Multi-user reminder identity (every User having a reminder-space id) is a future concern — most Users are currently unlinked and fall back to `a`.
- **R15 — `viewAs` Super-only** (faithful to the frontend picker).
- **R16 — complete/approve have no ownership check** (verbatim `remindersStore` behavior — the frontend gates via which tab shows the button, not the store). DELETE *does* add an owner/manager check (no frontend delete exists to contradict).
- **R17 — created reminder id `r-<uuid>`** (no DB default on `Reminder.id`).
- Prior risks R10/R12–R14 stand. **R1 resolved.**

## 9. Discovered inconsistencies
- None new. Visibility/grouping/state behavior matches the three reminder test suites exactly.

## 10. Recommended next phase
**Phase 6 — Attendance.** `POST /attendance/check-in`, `POST /attendance/check-out`, `GET /attendance/me`, `GET /attendance/team` using the verbatim `computePresence` / `autoPunch` / `facePunch` / `distanceMeters`, storing GPS + Wi-Fi + face-verification. Reproduce `attendance.test.ts` + `attendanceFlow.test.ts` over the API. DB is up — build + live-verify in one pass.

### ✅ Gate cleared
Live-verified end-to-end. No STOP conditions triggered (reminder visibility/grouping/state identical to source).
