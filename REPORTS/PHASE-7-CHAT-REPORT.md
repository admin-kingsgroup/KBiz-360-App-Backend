# PHASE 7 — CHAT MODULE (REST + Socket.IO realtime)
**Project:** KBiz360 Smart Connect — backend migration
**Status:** ✅ **Complete & fully verified (live DB + live Socket.IO).** TypeScript green; **18 suites / 109 tests, 0 skips**. Reproduces `chatUnread.test.ts` + `chatList.test.ts` over HTTP, plus a real socket test proving `message:new` delivery.
**Date:** 2026-06-11
**Stack:** Node.js + Express + TypeScript + Prisma + PostgreSQL + Socket.IO.

---

## 0. Scope
`GET /chats`, `GET /chats/:id/messages`, `POST /messages`, `POST /chats/:id/read`, plus **Socket.IO** realtime (`message:new`, `message:read`, `chat:typing`) and unread counts.

## 1. Files created
- `src/modules/chats/chats.service.ts` — global DM list (not access-filtered), per-user unread, messages, markRead, postMessage (+ realtime emit, audit).
- `src/modules/chats/chats.router.ts` — the 4 routes + zod.
- `src/modules/chats/__tests__/chats.integration.test.ts` — 5 supertest tests.
- `src/modules/chats/__tests__/chats.realtime.test.ts` — 1 live Socket.IO test.

## 2. Files modified
- `src/realtime/socket.ts` — connection auth (handshake token), `chat:join`/`chat:leave`/`chat:typing` handlers, `emitToChat()` helper.
- `src/app.ts` — mounted `/api` chat routes.
- `package.json` — dev `socket.io-client` (realtime test).
- **Frontend: untouched.** No schema change.

## 3. Architecture changes
- **DM list is GLOBAL and NOT access-filtered** (source-faithful): `GET /chats` returns all `Chat` rows, **self-excluded by name**, with unread from the **caller's `ChatParticipant`** (0 if none). Sort = unread-first then most-recent (verbatim `chatStore.sortedChats`).
- **Unread is per-user** (`ChatParticipant.unread`): `POST /chats/:id/read` sets it to 0 (mirrors `markRead`); `POST /messages` increments it for participants **other than the sender**.
- **Socket.IO rooms** `chat:<id>`: clients `chat:join`; the REST layer emits `message:new` (on send) and `message:read` (on read) to the room; `chat:typing` is relayed peer-to-peer. Handshake token optionally identifies the socket's user.

## 4. DB changes
- **None.** Uses existing `Chat`/`ChatParticipant`/`Message`.

## 5. API changes
| Method | Path | Notes |
|---|---|---|
| GET | `/api/chats` | `{ chats:[…unread-first, self-excluded], unreadTotal }` |
| GET | `/api/chats/:id/messages` | messages asc |
| POST | `/api/chats/:id/read` | mark caller's unread → 0; emits `message:read`; 204 |
| POST | `/api/messages` | `{ chatId, body }` → 201; emits `message:new`; bumps chat + others' unread |
| WS | `chat:join` / `chat:leave` / `chat:typing` | server → `message:new`, `message:read`, `chat:typing` |

## 6. Test results (LIVE)
- `npx jest` → **18 suites / 109 tests PASS, 0 skips**, clean exit.
- New **chat-integration (5):** Super `GET /chats` → 6 (self u1 excluded), `chats[0]=u3` (unread-first), `unreadTotal=3`; Employee → 7 (not access-filtered), `unreadTotal=0`; `read` → unread 0 + total 2; `POST /messages` then `GET messages` returns it; no-auth → 401.
- New **chat-realtime (1):** a Socket.IO client joins room `chat:u5`, a message is POSTed via REST, and the client receives `message:new` (`{chatId:'u5', body:'realtime hello', senderId:'a1'}`) — proving live delivery.

## 7. TypeScript results
- `npx tsc --noEmit` → **exit 0, 0 errors** ✅.

## 8. Risks
- **R22 — DM list is global, not per-user membership.** Faithful to the frontend's single global `directChats`. A true membership model (only chats you're in) is a future change; unread is already per-user.
- **R23 — unread increment for others is unexercised** by tests (seed gives each chat one participant = the sender). Multi-participant/group chats are a future enhancement.
- **R24 — socket auth is optional** (handshake token identifies the user but isn't enforced; rooms aren't scoped to participants). Production should enforce auth + authorize room joins.
- **R25 — markRead is an explicit `POST /chats/:id/read`** (the frontend marks on open; the client calls read on open).
- Prior risks stand. **R1 resolved.**

## 9. Discovered inconsistencies
- None new. Unread/sort/self-exclusion match `chatUnread.test.ts` + `chatList.test.ts` exactly.

## 10. Recommended next phase
**Phase 8 — Notifications.** `POST /notifications/register-device`, `GET /notifications`, `POST /notifications/read`, with **Expo Push** delivery queued through **BullMQ/Redis**. Wire payloads to the existing `routes.ts` deep-link map. (Redis needed for the queue — `docker compose up -d redis`.)

### ✅ Gate cleared
Live-verified end-to-end incl. realtime. No STOP conditions triggered (DM list/unread behavior identical to source).
