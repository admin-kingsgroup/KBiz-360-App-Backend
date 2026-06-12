# PHASE 8 — NOTIFICATIONS MODULE (Expo Push via BullMQ)
**Project:** KBiz360 Smart Connect — backend migration
**Status:** ✅ **Complete & fully verified (live DB + live Redis/BullMQ).** TypeScript green; **20 suites / 115 tests, 0 skips**. Device registration + list/read verified over HTTP; the push queue verified end-to-end (enqueue → worker → delivery).
**Date:** 2026-06-11
**Stack:** Node.js + Express + TypeScript + Prisma + PostgreSQL + BullMQ/Redis.

---

## 0. Scope
`POST /notifications/register-device`, `GET /notifications`, `POST /notifications/read`, with push delivery **queued through BullMQ** and sent via the **Expo Push API**, deep-linked through the existing `routes.ts` map.

## 1. Files created
- `src/queue/push.ts` — BullMQ producer (`enqueuePush`) + worker (`startPushWorker`) + Expo delivery (plain `fetch`, dry-run unless enabled) + `PUSH_DELIVERED` audit.
- `src/modules/notifications/notifications.service.ts` — registerDevice, list, markRead, `notify` (producer).
- `src/modules/notifications/notifications.router.ts` — the 3 routes + zod.
- `src/modules/notifications/__tests__/notifications.integration.test.ts` — 5 supertest tests.
- `src/modules/notifications/__tests__/notifications.queue.test.ts` — 1 BullMQ/Redis test.

## 2. Files modified
- `src/config/index.ts` — `push: { enabled, expoAccessToken }`.
- `src/app.ts` — mounted `/api/notifications`.
- `.env.example` — `EXPO_PUSH_ENABLED` (dry-run default).
- **Frontend: untouched.** No schema change. (No `expo-server-sdk` dep — it is ESM-only and breaks the CJS build/ts-jest; replaced with a direct `fetch` to the Expo push endpoint.)

## 3. Architecture changes
- New **Notifications module**. **Devices** are registered by Expo token (upsert — re-registering moves the token to the new user). **Notifications** are stored per user (`read` state) and listed newest-first.
- **`notify(userId, {title, body, data})`** (internal producer) creates the `Notification` row and **enqueues a `push-delivery` job** on BullMQ. It is resilient: if Redis is down, the row is still created (enqueue logs and continues).
- The **worker** loads the user's Expo tokens and, when `EXPO_PUSH_ENABLED=true`, POSTs to `https://exp.host/--/api/v2/push/send` (≤100/req); always writes a `PUSH_DELIVERED` audit (so delivery is observable in dry-run too).
- Notification `data` (`{type,id}`) is stored verbatim → the client deep-links via the existing `routes.ts` map unchanged (chat→`/chat/[id]`, alert→`/alert/[id]`, etc.).

## 4. DB changes
- **None.** Uses existing `Notification` + `Device`.

## 5. API changes
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/notifications/register-device` | `{ expoPushToken, platform? }` | upsert by token |
| GET | `/api/notifications` | — | newest-first; `{id,title,body,data,read,ts}` |
| POST | `/api/notifications/read` | `{ id }` or `{ all:true }` | `{ updated }` |

## 6. Test results (LIVE)
- `npx jest` → **20 suites / 115 tests PASS, 0 skips**, clean exit.
- New **notifications-integration (5):** register-device upsert; `notify()` → listed (unread, newest-first, data preserved); read `{id}`; read `{all}`; no-auth → 401.
- New **notifications-queue (1, BullMQ + Redis):** `notify('a2')` enqueues; the worker processes it and writes `PUSH_DELIVERED` (tokens=1, dry-run) — proving enqueue → worker → delivery end-to-end.

## 7. TypeScript results
- `npx tsc --noEmit` → **exit 0, 0 errors** ✅.

## 8. Risks
- **R26 — Expo delivery via direct HTTP** (no SDK; avoids the ESM/CJS interop issue). Dry-run by default (`EXPO_PUSH_ENABLED=false`). **Push receipts** and **token cleanup** on `DeviceNotRegistered` are future work.
- **R27 — `notify()` is internal and not yet triggered** by reminders/chat/attendance. Wiring those events to `notify()` (reminder due, new message, attendance anomaly, system alert) is a follow-up within their modules.
- **R28 — BullMQ needs Redis** (`docker compose up -d redis`). Enqueue is resilient if Redis is down (row still created), but delivery requires the worker + Redis.
- Prior risks stand. **R1 resolved.**

## 9. Discovered inconsistencies
- None new.

## 10. Recommended next phase
**Phase 9 — Audit + Uploads.** `GET /audit`, `GET /audit/:id` (read the AuditLog the prior phases already write); `POST /uploads` with the storage **adapter pattern** (`LocalStorageAdapter` / `S3StorageAdapter`) returning `{ id, url }`. Then the final phases: **frontend API layer** (`src/api/*` replacing `src/data/*`) and the **production-readiness report**.

### ✅ Gate cleared
Live-verified end-to-end incl. BullMQ/Redis. No STOP conditions triggered.
