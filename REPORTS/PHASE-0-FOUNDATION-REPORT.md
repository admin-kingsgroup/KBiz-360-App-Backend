# PHASE 0 — BACKEND FOUNDATION REPORT
**Project:** KBiz360 Smart Connect — backend migration
**Status:** Inspection complete. **No code written.** Awaiting approval to begin Phase 1.
**Date:** 2026-06-10
**Scope source of truth:** `Frontend/src/types/*`, `Frontend/src/constants/*`, `Frontend/src/logic/*` (canonical, locked).

> This report is mandated by `Frontend/CLAUDE.md` and the backend brief: *"Do NOT begin implementation
> until that report is complete."* It documents what exists today so the backend can reproduce it 1:1.

---

## 0. Executive summary

- The frontend is a **complete, faithful port** of the original PWA, with **all data mocked** and **no backend**. `Backend/` is empty (greenfield).
- **76 tests across 16 suites pass.** These tests are the **behavioral contract** the backend must satisfy.
- All business logic lives in **pure, RN-free TypeScript** (`src/logic/*`) — it can be **lifted verbatim** into the NestJS backend, which is the safest way to guarantee identical behavior.
- **Three independent identity systems coexist by design** and are **mutually inconsistent** for the "same" people (different roles/depts/surnames). They **cannot be flattened into one role-per-person** without changing access/visibility output. The required Prisma entity list already separates `User` from `ReminderViewer` — that separation is the correct, behavior-preserving resolution.
- **One pre-existing baseline defect:** `npm run typecheck` (full `tsc`) **fails** (1 error) even though `npm test` is green. This contradicts the CLAUDE.md "all three checks green" claim. It is unrelated to the backend but will matter when we wire the frontend API layer. See §10 / Risks.

---

## 1. Existing frontend architecture

**Stack:** Expo SDK 51 · expo-router (file-based, typed routes) · React Native 0.74 · TypeScript strict · NativeWind v4 · Zustand 4 · lucide-react-native. Native: expo-location, expo-local-authentication, expo-notifications, @react-native-community/netinfo. Tests: Jest + ts-jest.

**Strict layering (one direction):** `types → constants/data → logic → store → components → routes`.
- Pure logic never imports RN or stores. Stores never import UI.
- Access control is centralized: all visibility flows through `deriveAccess` + `makeAccessFilters` + `makeCanSee`. Components never re-implement filtering.

**Routes (`Frontend/app/`):** `(auth)/login,permissions` · `(tabs)/index,reminders,call,email,profile` · `chat/[id]` · `attendance` · `admin/users,roles,user-form,businesses` · `business/[id]` · `department/[id]` · `alert/[id]` · `reminder/new,archive` · `view-as`.

**Gate flow (pure, `navigation/guards.ts`):** signed-out → `login`; signed-in + perms ungranted → `permissions`; else → `app`. `allPermsGranted = location && notifications && network`. "View as" is **never** a routing input.

**Persistence today:** session-only (resets on reload) **except** permissions + attendance consent, persisted to AsyncStorage (`services/storage/prefs.ts`, keys `kb360_perms`, `kb360_attConsent`). Login is **not** persisted (shows every launch). Auth is **simulated** — every login button signs in as Afshin (`a1`, Super Admin).

---

## 2. Existing types (`src/types/*` — LOCKED)

| Type | Key fields / notes |
|---|---|
| `RoleKey` | `'SUPER_ADMIN' \| 'DIRECTOR' \| 'GENERAL_MANAGER' \| 'BRANCH_MANAGER' \| 'HOD' \| 'EMPLOYEE'` (order = hierarchy) |
| `RoleDef` | key,label,badge,color,scope,sees,perms[] (icon excluded — UI-only) |
| `User` | id,name,initials,color,role,email?,**bizId:string\|null**,branches[],accessGroups[],accessDepts[],accessAlerts[],attendance?,scopeLine?,login? |
| `GrantId` | branch-qualified string, e.g. `'AMD-Accounts'` (group/dept) or `'AMD-crm'` (alert) |
| `PersonMeta` | `{ role, branches[], dept:string\|null }` — **reminder-visibility identity, separate id space** |
| `ReminderViewer` | `PersonMeta & { id }` |
| `AccessControl` | DERIVED runtime obj; `null` field = unrestricted (Super). isSuper,role,name,bizIds,branches,groups,depts,alerts,canManage |
| `Permissions` | location,notifications,network (all boolean) |
| `Business / Branch / Group / Department` | org tree; `Branch` carries geo: lat,lng,radius(m),wifi(SSID),tz,groups[] |
| `ModuleDef / ModuleKey` | 7 modules: crm,accounts,pl,hr,payables,receivables,inventory |
| `SystemAlertChannel` | `id = ${bizId}_${module}` |
| `Reminder` | id,title?,text?,section,forId,forName,forInitials?,forColor?,byId,byName?,state?,date? |
| `ReminderState` (type) | `'open' \| 'approved' \| 'review' \| string` ⚠️ (runtime data uses **`'pending'`**, not `'open'` — see §10) |
| `ReminderGroup` | key,mode('person'\|'role'),items[], + person/role display fields |
| `AttendanceRecord` | inTime:Date\|null, outTime:Date\|null, via:PunchMethod\|null |
| `PunchMethod` | `'Wi-Fi' \| 'Geofence' \| 'Face' \| 'Auto'` |
| `OfficeGeo/Coords/OfficePresence/TeamAttendanceEntry` | geo + presence DTOs |
| `Chat` | id,kind('direct'\|'group'),name,bizId?,branchCode?,unread?,ts?,preview?,online? |
| `Message` | id,chatId,senderId,body,ts,status?('sent'\|'delivered'\|'read') |
| `AppNotification` | id,title,body,data?,ts,read |
| `Country` | name,flag,tz |

---

## 3. Existing access-control logic (`src/logic/` — LOCKED, must reproduce **exactly**)

**`deriveAccess(effUser)` → `AccessControl`** (`logic/access.ts`)
- `isSuper = role === 'SUPER_ADMIN'`.
- For super: `bizIds/branches/groups/depts/alerts` are all **`null`** (= unrestricted). For non-super: `bizIds = bizId ? [bizId] : []`, others default to `[]`.
- `canManage = isSuper || role === 'DIRECTOR'`.

**`makeAccessFilters(access)`** (`logic/accessFilters.ts`) — `access` null/undefined treated as **Super**.
- `isSuper = !access || access.isSuper`.
- `bizOK(id) = isSuper || bizIds.includes(id)`
- `brOK(code) = isSuper || branches.includes(code)`
- `grpOK(code,name) = isSuper || groups.includes(\`${code}-${name}\`)`
- `deptOK(code,name) = isSuper || depts.includes(\`${code}-${name}\`) || depts.includes(name)` ← **bare-name backward-compat path (tested, must keep)**
- `alertOK(code,mod) = isSuper || (code && alerts.includes(\`${code}-${mod}\`)) || alerts.includes(mod)` ← **bare-module path (must keep)**

**`makeCanSee(viewer, personMeta)(targetId)`** (`logic/canSee.ts`) — reminder visibility, **separate identity space**:
1. `targetId === viewer.id` → **true** (always your own).
2. unknown target → false.
3. `RANK[target.role] <= RANK[viewer.role]` → **false** (only **strictly below** you).
4. SUPER_ADMIN → true; DIRECTOR → true (whole business).
5. HOD → `target.dept === viewer.dept && overlap(target.branches, viewer.branches)`.
6. GM / BRANCH_MANAGER → `overlap(target.branches, viewer.branches)`.

`RANK = {SUPER_ADMIN:0,DIRECTOR:1,GENERAL_MANAGER:2,BRANCH_MANAGER:3,HOD:4,EMPLOYEE:5}` (lower = higher authority).

> ⚠️ `deriveAccess`/`makeAccessFilters` operate on the **adminUsers (`a1..a8`) access space**; `makeCanSee` operates on the **PERSON_META (`a,fa,p,…`) space**. They are intentionally different inputs (§6).

---

## 4. Existing reminder logic (`src/logic/reminderGrouping.ts` + `store/remindersStore.ts`)

- **`applyCanSee(live, viewer, personMeta)`** — used only on the **"All" tab**: `live.filter(r => canSee(r.forId))`.
- **`groupReminders(visible, {isAll, personMeta, roleDefs})`**:
  - **All tab → person-wise**: bucket by `forId`; order by `RANK[role]` then `forName.localeCompare`; within a person sort by `sectionRank` (today=0, week=1, else=2). Group `sub = roleDefs[role].label`.
  - **Other tabs → role-tier**: bucket by role; emit in `ROLE_OPTIONS` order; only non-empty tiers.
- **Filter tabs** (`constants/filters.ts`): `['For me','I set','Review','All']` — index 3 ("All") triggers the person-wise + canSee path.
- **State machine (`remindersStore`)** — copied verbatim from source:
  - `complete(id)`: self-assigned (`byId===forId`) → `state:'approved'` (+completedAt,approvedAt), returns `'archived'`. Assigned-by-other → `state:'review'` (+completedAt), returns `'review'`.
  - `approve(id)`: `review → approved` (+approvedAt).
  - `add(r)`: **prepends**.
- **Runtime reminder state values:** `'pending' | 'review' | 'approved'` (`data/reminders.ts`). `getReminderBiz()` returns `'personal'` for self/self, else `PEOPLE_BIZ[otherId]`. `CURRENT_USER_ID = 'a'`. `HOURS_48` defined for overdue logic.

---

## 5. Existing attendance logic (`src/logic/attendance.ts` + `geo.ts` + `store/attendanceStore.ts`)

- **`distanceMeters(a,b)`** — Haversine, R=6371000m, **rounded** to integer.
- **`computePresence({wifiOn,coords,office})`** → `{distance, inside, present, viaNow}`:
  - `inside = distance != null && distance <= office.radius`
  - `present = wifiOn || inside`
  - `viaNow = wifiOn ? 'Wi-Fi' : (inside ? 'Geofence' : '')`
- **`autoPunch(att, present, viaNow, now)`** → next record or `null`:
  - present & no inTime → check **IN** (`via = viaNow || 'Auto'`).
  - !present & inTime & no outTime → check **OUT**.
  - else → `null` (no transition).
- **`canFacePunch(present, att, scanning)`** — false if not present, scanning, or already fully punched.
- **`facePunch(att, now)`** — sets IN (`via:'Face'`) if no inTime, else OUT; no-op once both set.
- Store wires these with `now = new Date()` injected for testability. Geofence is real (expo-location); **Wi-Fi presence is a simulated toggle** (no native SSID detection). Biometric falls through to success when no biometric enrolled (see `app/attendance.tsx`).
- **Backend must store:** GPS coords, Wi-Fi/SSID metadata, face-verification result (brief requires it; frontend currently keeps only `{inTime,outTime,via}` in memory + a Super-Admin team dashboard from `data/team.ts`).

---

## 6. Existing identity systems (REQUIRED ANALYSIS — see also §IDENTITY DECISION)

**Three identity spaces coexist by design** (`Frontend/CLAUDE.md` §"Known design facts"):

1. **`adminUsers` (`a1..a8`)** — the **access / Team / "View as"** space. Drives `deriveAccess` + `makeAccessFilters`. Signed-in user = `a1` (Afshin, Super Admin).
2. **`PERSON_META` (`a, fa, p, f, m, r, sn, ko, an`)** — the **reminder-visibility / canSee** space. `CURRENT_USER_ID = 'a'`. `ROLE_VIEWERS` maps each role → a representative viewer id.
3. **DM ids (`u1..u7`)** — the **chat list** space (`data/chats.ts`).

Plus two satellite spaces: `reminderPeople` (composer picker, 8 people, **omits `an`**) and `teamAttendance` (`t1..t7`, includes "Anjali Sharma" not present elsewhere).

### How they differ — they are NOT consistent for the "same" person:

| Person | access (adminUsers) | reminder (PERSON_META) | chat (DM `role` line) |
|---|---|---|---|
| Afshin | `a1` SUPER_ADMIN | `a` SUPER_ADMIN | `u1` Super Admin |
| Farhan Aga | `a2` DIRECTOR (AMD/BOM/NBO) | `fa` DIRECTOR | `u2` Business View |
| Pravesh | `a3` GENERAL_MANAGER (AMD/BOM) | `p` GENERAL_MANAGER (AMD/BOM) | — |
| **Faiz** | `a4` **"Faiz Patel" HOD** (AMD/BOM/NBO) | `f` **"Faiz Khan" BRANCH_MANAGER** (AMD) | `u3` "Faiz Khan" Branch View · 3 branches |
| **Mehul Raj** | — | `m` **HOD / Accounts** (AMD) | `u4` **Employee · Ticketing** |
| **Riya Patel** | — | `r` EMPLOYEE / **Ticketing** (AMD) | `u5` Employee · **Holidays** |
| Sanjay Nair | — | `sn` EMPLOYEE / Accounts (BOM) | `u6` Employee · BOM |
| Karen Owino | — | `ko` EMPLOYEE / Holidays (NBO) | `u7` Employee · NBO |
| Harshit / Rohan / Nandni / Nurul | `a5/a6/a7/a8` | — | — |
| Anjali | — | `an` EMPLOYEE / MKTG (BOM) | — (teamAttendance `t7` only) |

**Conclusion:** roles, departments, branch scope and even surnames **diverge** between spaces for the same nominal person (Faiz, Mehul, Riya). `deriveAccess` reads space #1; `makeCanSee` reads space #2; the DM list reads space #3 and is **deliberately not access-filtered**. **Collapsing these into a single role/scope per user would change `canSee`/`makeAccessFilters` output → a STOP condition.**

### Proposed canonical backend `User` model (behavior-preserving)
- One canonical `User` (stable new id) holding **auth + the access facet** (role, bizId, branches[], accessGroups[], accessDepts[], accessAlerts[]) — i.e. the `adminUsers` shape, served unchanged to `deriveAccess`.
- A **separate `ReminderViewer` entity** (already in the required schema!) holding the **PERSON_META facet** (role, branches[], dept) keyed by its own id (`a,fa,…`), with a **nullable** FK to `User`. This is fed to `makeCanSee` unchanged. **Roles/depts here are stored, not derived from `User.role`.**
- A **`dmKey`/alias** (or a `ChatParticipant` link) for the `u1..u7` space.
- Where a confident link exists (Afshin = a1 = a = u1; Farhan = a2 = fa = u2), set the FK for display/auth join only. Where it **does not** (Faiz role conflict; Mehul/Riya dept conflict; Anjali/Harshit/Rohan/Nandni orphans) **leave unlinked** and **REPORT** — do not invent a merge.

This keeps each frontend consumer reading the exact same data shape it reads today → **identical behavior, verified by the existing 76 tests.**

---

## 7. Existing stores (`src/store/*` — Zustand, behavior LOCKED)

| Store | State | Notable actions / selectors |
|---|---|---|
| `authStore` | user, token(null), status | signIn/signOut/isAuthenticated. **Token refresh = [NEEDS BACKEND].** |
| `accessStore` | user, **viewAsUser**, users[] | `effUser() = viewAsUser \|\| user`; `access() = deriveAccess(eff)`; `canManage()`; `upsertUser` (id-stable, no dup). |
| `attendanceStore` | att, perms, consent, presence | `refreshPresence`, `runAutoPunch(now?)`, `punchByFace(now?)`, `hydrate`, `reset`. |
| `chatStore` | chats[], messagesByChat | `markRead` (unread→0), `unreadTotal`, `sortedChats` (**unread-first then ts desc**), `appendMessage`. Transport-agnostic. |
| `remindersStore` | reminders[] | `complete`/`approve`/`add` (§4). Seeds from `data/reminders`. |
| `pulseStore` | events[] | `markEventRead`, `markChannelRead`, `eventsFor(channel)` (**newest-first**). |
| `uiStore` | activeBizId('all'), activeSegment('chats'), toast | `setBiz/setSegment/showToast`. UI-only. |

> Migration intent (CLAUDE.md): stores stay; they become **cache/state** behind an API. Backend becomes source of truth. `store/index.ts` only barrels 5 of 7 (reminders/pulse imported directly).

---

## 8. Existing mock data sources (`src/data/*` — each maps to a DB table + seed)

| File | Provides | Becomes |
|---|---|---|
| `data/businesses.ts` | 7 businesses; 3 branches (tk only) w/ geo+wifi+groups; `businessDepts`; `branchesFor` | `Business`,`Branch`,`Group`,`Department` tables + seed |
| `data/users.ts` | `adminUsers` (a1–a8), `PERSON_META`, `ROLE_VIEWERS` | `User`, `ReminderViewer` (§6) |
| `data/reminders.ts` | `seedReminders` (16), `reminderPeople`, `PEOPLE_BIZ`, `CURRENT_USER_ID='a'` | `Reminder` table + seed |
| `data/chats.ts` | `directChats` (u1–u7), `sortChats`, `directChatsAsChats` | `Chat`,`Message`,`ChatParticipant` + seed |
| `data/pulse.ts` | `pulseChannels` (biz×module), `pulseEvents` (15), `branchOf`, `moduleRank` | `AlertChannel`,`Notification`/`AlertEvent` + seed |
| `data/team.ts` | `teamAttendance` (t1–t7) — Super-Admin dashboard | `AttendanceRecord` (seed) |
| `constants/*` | roles/RANK, modules/BIZ_MODULES, departments, filters, permissions, countries | reference seed / enums |

---

## 9. Existing chat architecture

- **DM list (`Home › Chats`):** sourced from `directChats`, **NOT access-filtered and NOT affected by View-As** (source-faithful). Caller excludes the signed-in user **by name**; sort = unread-first then `ts` desc (`sortChats`). `directChatsAsChats()` seeds `chatStore` so opening a chat (`markRead`) zeroes its unread.
- **Group chats:** currently reuse the DM detail screen with mock starter messages; **real group membership + messages = [NEEDS BACKEND].**
- **Unread:** `chatStore.unreadTotal()` = Σ `unread`; `markRead(chatId)` sets that chat's unread to 0. Receipts (`✓✓`) are **cosmetic** today.
- **Realtime (Socket.IO target):** `message:new`, `message:read`, `chat:typing` — none exist client-side yet; transport is deliberately abstracted behind the store.

---

## 10. Behavior that CANNOT be changed (locked invariants + their guards)

1. **`deriveAccess`/`makeAccessFilters`/`makeCanSee` output** — byte-for-byte. Guards: `access.test.ts`, `canSee.test.ts`, `homeSegments.test.ts`. Includes the **bare-name `deptOK`** and **bare-module `alertOK`** compat paths.
2. **`null` = unrestricted** for Super in `AccessControl`; `makeAccessFilters(null)` = Super.
3. **canSee = strictly-below-rank + own-id-always-visible**; HOD needs dept **and** branch overlap.
4. **Reminder grouping**: All-tab person-wise (RANK then name; today<week within person); else role-tier in `ROLE_OPTIONS` order. Guard: `reminderGrouping.test.ts`.
5. **Reminder state machine**: self→approved/'archived'; other→'review'; approve→approved. Guard: `remindersStore.test.ts`.
6. **Attendance**: presence/auto-punch/face-gating math exactly as §5. Guards: `attendance.test.ts`, `attendanceFlow.test.ts`, `stores.test.ts`. `distanceMeters` rounding preserved.
7. **Chat unread**: unread-first sort, `markRead`→0, `unreadTotal` sum; **DM list not access-filtered.** Guards: `chatUnread.test.ts`, `chatList.test.ts`, `stores.test.ts`.
8. **Gate**: signed-out→login, perms-pending→permissions, else app; View-As never routes. Guards: `guards.test.ts`, `authFlow.test.ts`.
9. **Notification routing** map (`routes.ts`): chat→`/chat/[id]`, alert→`/alert/[id]`, attendance→`/attendance`, reminder→`/(tabs)/reminders`, else `/(tabs)`. Guard: `notificationRouting.test.ts`.
10. **User-create validation** (`validateUserDraft`): branch-qualified availability; effBranches only for `tk`; Super valid on name+email alone. Guard: `validation.test.ts`.
11. **Three identity spaces stay separate** until the backend links them without changing output (§6).

---

## Discovered inconsistencies (report-only; no fixes applied)

- **D1 — `tsc` baseline is RED.** `npx tsc --noEmit` exits **2**: `src/hooks/useNotificationRouting.ts:16` — `routeForData` returns a widened `{pathname:string}` not assignable to expo-router's typed `Href`. `npm test` is green because `tsconfig.jest.json` excludes `app/` + typed routes. Contradicts CLAUDE.md "all three checks green." **Pre-existing; not introduced here.** Will affect the frontend API-layer phase.
- **D2 — ReminderState type vs data.** `types/reminder.ts` says `'open'|'approved'|'review'`; runtime data/store use **`'pending'`**, not `'open'`. Backend enum should be `pending|review|approved`.
- **D3 — Identity divergence** (Faiz role/surname, Mehul & Riya dept) across spaces — §6. Blocks naive unification.
- **D4 — Orphan identities:** Harshit/Rohan/Nandni/Nurul (access-only), Anjali (reminder+team only) have no cross-space counterpart; `reminderPeople` omits `an`.
- **D5 — Name drift:** seed reminder `forName` "Pravesh Jha" vs adminUsers "Pravesh" vs picker "Pravesh"/initials PJ vs PR.

---

## Verification baseline (this inspection)

- `npm test` → **76 passed / 16 suites** ✅
- `npx tsc --noEmit` → **FAIL (1 error, exit 2)** ❌ (pre-existing, D1)
- `npm run lint` → not run this pass.

---

## Recommended next phase (Phase 1)

**Phase 1 — Backend scaffold + Prisma schema + domain-logic port (no behavior, no endpoints yet).**
1. Scaffold NestJS (strict TS), config, Prisma + Postgres, Redis/BullMQ wiring, health check.
2. **Lift `src/logic/*` + `constants/{roles,modules,…}` verbatim** into a backend `domain/` (or shared package) — `access`, `accessFilters`, `canSee`, `reminderGrouping`, `attendance`, `geo`, `validation`. Re-run the **same Jest specs** against the backend copy to prove identical behavior.
3. Author the full **Prisma schema** for: User, Role, Business, Branch, Group, Department, AlertChannel, Reminder, **ReminderViewer (separate identity)**, AttendanceRecord, Chat, Message, ChatParticipant, Notification, Device, AuditLog, RefreshToken, Upload — relationships chosen to preserve §6 + grant strings verbatim.
4. Migration + seed scripts that reproduce **every** `src/data/*` dataset exactly.
5. Report in the Phase-1..12 format.

### ⛔ DECISION REQUIRED BEFORE PHASE 1 (per IDENTITY MODEL + STOP CONDITIONS)
Approve the **identity strategy**: keep `User` (access) and `ReminderViewer` (canSee) as **separate linked entities**, preserving each facet's stored role/branch/dept and **not merging** divergent records (Faiz/Mehul/Riya/orphans). This is the only approach that keeps the 76 tests green. **Awaiting approval.**
