# Approvals API — frontend integration guide

Backend for the **Approvals** tab (New request · My approvals · request detail sheet) of KBiz 360 Smart Connect.

| | |
|---|---|
| Base URL (production) | `https://kbiz360.duckdns.org` |
| Prefix | `/api/approvals` |
| Auth | `Authorization: Bearer <accessToken>` on every call — the same token the rest of the app already uses (`POST /api/auth/login` → `accessToken`, 15 min, refresh with `POST /api/auth/refresh`) |
| Format | JSON in, JSON out. Dates are ISO 8601 strings (UTC). IDs are 24-char hex strings. |
| Who is "me" | Always the logged-in user from the token. No endpoint takes a `userId` for the caller. |

> **What changed (N-level chains).** The chain is no longer fixed by role. The requester builds it: **any number of levels, one or more approvers on each level**. The old body (`approvers: [{ step, userId }]`) and the old response fields (`steps[]`, `totalSteps`, `currentStep`, `currentApprover`) still work, so the current app build keeps running — but the New request form should move to `levels[]`. Section 9 lists exactly what to change.

## 1. How the approval chain works

The requester adds levels and puts people on them. The request travels the levels **strictly in order**:

```
Requester ──► Level 1 ──► Level 2 ──► … ──► Level N ──► APPROVED
              (1+ people) (1+ people)        (1+ people)
                 │ reject     │ reject          │ reject
                 └────────────┴─────────────────┴──► REJECTED (chain stops)
```

- **Levels**: 1–10 per request, each with a name (`label`, optional — defaults to "Level 1", "Level 2"…) and 1–10 approvers. A person can be on **one** level only, and never the requester.
- **Who can be an approver**: anyone in the company who can use the app (active + App Access on). `GET /approvers` lists them; `GET /hierarchy` also returns the same list plus a suggested role-based chain (branch manager → company manager → business owner) the form may pre-fill.
- **Level `mode`** — what closes a level with more than one person:
  - `all` (default): **everyone** on the level must approve.
  - `any`: the **first** approval closes the level; the others' slots become `skipped` (they keep seeing the request, they just no longer need to act).
  - A **reject by anyone** on the level ends the request in both modes.
- The request goes to **level 1 only**. Level 2 does not see it — not in their list, not by id — until level 1 is closed. And so on.
- **Approve** that closes the last level → `approved`. **Reject** anywhere → `rejected` at once; everyone undecided (rest of the level + later levels) is `skipped` and later levels never see it.
- Only a person whose **turn** it is can decide. `canAct` tells you exactly that — show Approve / Reject only when `canAct === true`.
- The requester can **withdraw** a pending request (`canCancel === true`). People who already decided keep seeing it; people who had not acted yet drop it.

### Statuses

**Request `status`** — the pill on the card and the filter chips:

| value | meaning | pill |
|---|---|---|
| `pending` | still travelling the chain | Pending (amber) |
| `approved` | every level closed with approval | Approved (green) |
| `rejected` | someone rejected it | Rejected (red) |
| `cancelled` | the requester withdrew it | (only under "All requests") |

**Level `status`** and **approver `status`** (same vocabulary) — the icon on each row of "Approval hierarchy":

| value | meaning | suggested icon |
|---|---|---|
| `pending` | it is this level's / person's turn right now (`isCurrent: true` on the level) | amber clock |
| `waiting` | not reached yet | grey clock |
| `approved` | approved | green check |
| `rejected` | rejected | red cross |
| `skipped` | never needed — the request ended first, or (mode `any`) a colleague approved first | grey dash |

A level in mode `all` with 2 of 3 approved is still `pending`; use `approvedCount` / `requiredCount` for a "2 of 3" caption.

## 2. Screen → endpoint map

| Screen | Call |
|---|---|
| **New request** opens | `GET /api/approvals/hierarchy` → limits for the level builder, the people list, a suggested chain |
| Search in the person picker (optional) | `GET /api/approvals/approvers?q=faiz` |
| New request → Submit | `POST /api/approvals` with `levels[]` |
| **My approvals**, chip "All requests" | `GET /api/approvals` |
| Chip Pending / Approved / Rejected | `GET /api/approvals?status=pending` (`approved`, `rejected`) |
| Tap a card → detail sheet | the list item already contains `levels[]`; `GET /api/approvals/:id` to refresh |
| **Approve** / **Reject** | `PUT /api/approvals/:id/decision` |
| Withdraw | `PUT /api/approvals/:id/cancel` |
| Badge on the Approvals tab icon | `GET /api/approvals/counts` → `actionable` |

## 3. Shared shapes

```ts
type Person = {
  id: string;
  name: string;            // "Faiz Patel"
  initials: string;        // "FP"
  color: string;           // "#4F8BFF" — avatar background when there is no photo
  avatar: string | null;   // photo URL
  position: string | null; // job title, e.g. "Finance Manager"
};

// A person who can be put on a level (the picker rows)
type ApproverCandidate = Person & {
  email: string | null;
  role: string | null;     // CRM role: "super_admin" | "company_manager" | "branch_manager" | "hod" | "employee"
  level: number;           // CRM role level: 1 = business owner … 5 = employee
  branches: string[];      // branch codes, e.g. ["BOM"]
};

type ApprovalApprover = {
  approver: Person;
  status: 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped';
  decidedAt: string | null;
  note: string;            // what they wrote ("" if nothing)
};

type ApprovalLevel = {
  order: number;           // 1, 2, 3 …
  key: string | null;      // "branch_manager" etc. when the level came from the role chain, else null
  label: string;           // "Managers", "Level 2", "Branch manager"
  mode: 'all' | 'any';
  status: 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped';
  isCurrent: boolean;      // the request is sitting on this level right now
  decidedAt: string | null;
  approvedCount: number;   // approvals so far
  requiredCount: number;   // approvals that close the level: everyone (all) or 1 (any)
  approvers: ApprovalApprover[];
};

type Approval = {
  id: string;
  title: string;
  details: string;
  category: string;        // "Salary" | "Holiday" | "Leave" | "Expense" | "Purchase" | "Travel" | "HR" | "General"
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  submittedAt: string;     // ISO
  decidedAt: string | null;// ISO — when it became approved / rejected / cancelled
  requester: Person;
  totalLevels: number;
  currentLevel: number | null;    // 1-based; null once the request is final
  currentApprovers: Person[];     // everyone still to decide on that level; [] once final
  levels: ApprovalLevel[];
  // ── kept for the previous app build (one row per approver, flattened) ──
  totalSteps: number;             // = totalLevels
  currentStep: number | null;     // = currentLevel
  currentApprover: Person | null; // = currentApprovers[0]
  steps: Array<{ order: number; level: number; key: string; label: string; approver: Person; status: string; isCurrent: boolean; decidedAt: string | null; note: string }>;
  // ── relative to the logged-in user ──
  isMine: boolean;         // I raised it
  canAct: boolean;         // it is MY turn → show Approve / Reject
  canCancel: boolean;      // I can withdraw it
  myDecision: 'approved' | 'rejected' | null; // what I decided on my own level
};
```

Card subtitle ("Rohan Mehta · Salary") = `requester.name · category`. Card date = `submittedAt`. Card "waiting on" = `currentApprovers.map(p => p.name).join(', ')`.

## 4. Endpoints

### 4.1 `GET /api/approvals/hierarchy` — data for the New request form

Response `200`:

```json
{
  "levels": { "min": 1, "max": 10, "maxApproversPerLevel": 10, "labelMaxLength": 40, "modes": ["all", "any"], "defaultMode": "all" },
  "approvers": [
    { "id": "66f1…a01", "name": "Faiz Patel", "initials": "FP", "color": "#37B6A4", "avatar": null, "position": "Branch Manager", "email": "faiz@…", "role": "branch_manager", "level": 3, "branches": ["BOM"] }
  ],
  "suggestedLevels": [
    { "order": 1, "label": "Branch manager",  "mode": "all", "approverIds": ["66f1…a01"], "candidateIds": ["66f1…a01"] },
    { "order": 2, "label": "Company manager", "mode": "all", "approverIds": [],           "candidateIds": ["66f1…b02", "66f1…b03"] },
    { "order": 3, "label": "Business owner",  "mode": "all", "approverIds": [],           "candidateIds": ["66f1…c03", "66f1…c04"] }
  ],
  "totalSteps": 3,
  "steps": [ /* the old fixed role steps with candidates — previous app build only */ ],
  "categories": ["Salary", "Holiday", "Leave", "Expense", "Purchase", "Travel", "HR", "General"],
  "limits": { "title": 120, "details": 2000, "note": 500, "label": 40, "levels": 10, "approversPerLevel": 10 }
}
```

- `approvers` = everyone the caller may put on a level (sorted by name, the caller excluded). Use it for the picker; for a search box on a long list call `GET /approvers?q=`.
- `suggestedLevels` = a ready-made chain by role. Optional: offer it as "Use default hierarchy" or as the initial state of the builder. `approverIds` is pre-filled only when a step has exactly one candidate; `candidateIds` are the people that step would normally be picked from. It can be `[]` (e.g. a business owner with no fellow owner on the app) — the builder still works, they just start empty.
- Enforce `levels.*` and `limits` client-side to avoid a 400.

### 4.2 `GET /api/approvals/approvers?q=&limit=` — the person picker

| param | default | meaning |
|---|---|---|
| `q` | — | case-insensitive match on name, email, role, job title, branch code |
| `limit` | 200 | 1–500 |

Response `200`:

```json
{ "total": 1, "items": [ { "id": "66f1…a01", "name": "Faiz Patel", "initials": "FP", "color": "#37B6A4", "avatar": null, "position": null, "email": "faiz@…", "role": "branch_manager", "level": 3, "branches": ["BOM"] } ] }
```

### 4.3 `POST /api/approvals` — submit a request

Body:

```json
{
  "title": "Salary release approval",
  "details": "Requesting approval to release the September salary payment for the Ahmedabad team.",
  "category": "Salary",
  "levels": [
    { "label": "Managers", "mode": "all", "approverIds": ["66f1…a01", "66f1…b02"] },
    { "label": "Finance",  "mode": "any", "approverIds": ["66f1…d04", "66f1…d05"] },
    { "approverIds": ["66f1…c03"] }
  ]
}
```

| field | rules |
|---|---|
| `title` | required, 1–120 chars |
| `details` | required, 1–2000 chars |
| `category` | optional. Omitted → read off the title ("Salary release approval" → `Salary`, "Client visit expense" → `Expense`, else `General`). |
| `levels` | 1–10 entries, **in review order**. Each: `approverIds` 1–10 ids from `/hierarchy.approvers` (or `/approvers`); `label` optional (max 40, default "Level n"); `mode` optional (`all` \| `any`, default `all`). |
| `approvers` | **legacy** (previous app build): `[{ step, userId }]`, one per fixed role step. Ignored when `levels` is sent. |

Response `201` → the created `Approval` (`status: "pending"`, `currentLevel: 1`, level 1 and everyone on it `pending`, the rest `waiting`).

Errors: `400 VALIDATION` (missing/too-long field, empty `levels`, empty `approverIds`, unknown `mode`), `400 BAD_REQUEST` with a user-readable message (yourself as an approver, the same person on two levels, a person who cannot use the app), `422 NO_APPROVERS` (legacy body only: the user has no role hierarchy).

### 4.4 `GET /api/approvals` — the My approvals list

Query (all optional):

| param | values | default | meaning |
|---|---|---|---|
| `scope` | `all` \| `mine` \| `assigned` \| `actionable` | `all` | `all` = requests I raised **+** requests that have reached me · `mine` = only ones I raised · `assigned` = only ones that reached me · `actionable` = only ones waiting on **me** right now |
| `status` | `pending` \| `approved` \| `rejected` \| `cancelled` | — | the filter chips |
| `page` | 1… | `1` | |
| `limit` | 1–100 | `50` | |

Response `200`:

```json
{
  "scope": "all", "status": null, "page": 1, "limit": 50, "total": 4, "hasMore": false,
  "counts": { "all": 4, "pending": 1, "approved": 2, "rejected": 1, "cancelled": 0, "actionable": 1 },
  "items": [ /* Approval[] — newest first, each with its full levels[] */ ]
}
```

- `counts` is for the current `scope` **ignoring** the `status` filter, so one response fills all four chips. `counts.actionable` = how many are waiting on me right now.
- "Reached me" = I am on a level the request has arrived at (or I already decided). Later levels do not see it yet.

### 4.5 `GET /api/approvals/:id` — one request (detail sheet)

Response `200` → `Approval`.

`404 NOT_FOUND` if the request does not exist **or the user is not allowed to see it yet** (a later level gets 404 on purpose). Allowed: the requester, anyone on a level the request has reached, and super admins.

### 4.6 `PUT /api/approvals/:id/decision` — Approve / Reject

Body: `{ "action": "approve" | "reject", "note": "optional, max 500" }` (note recommended on reject — the requester sees it).

Response `200` → the updated `Approval`. Replace the item in your list with it. What you will see:

| case | result |
|---|---|
| approve, level mode `all`, others still pending | `status: "pending"`, same `currentLevel`, `levels[i].approvedCount` +1, `canAct: false`, `myDecision: "approved"` |
| approve that closes the level (last of `all`, or first of `any`) | `currentLevel` +1, next level `pending`; in `any` the colleagues' slots become `skipped` |
| approve that closes the **last** level | `status: "approved"`, `currentLevel: null` |
| reject | `status: "rejected"`, the rest of the level + later levels `skipped` |

| status | `error.code` | when |
|---|---|---|
| 404 | `NOT_FOUND` | no such request, or the user is not on its chain |
| 409 | `NOT_YOUR_TURN` | an earlier level has not closed yet |
| 409 | `ALREADY_DECIDED` | this user already decided, or their level already closed |
| 409 | `NOT_PENDING` | the request is already approved / rejected / cancelled |
| 409 | `STALE` | someone else on the level decided at the same moment — refetch and retry |

If you show the buttons only when `canAct`, users practically never hit a 409; on any 409, refetch the item.

### 4.7 `PUT /api/approvals/:id/cancel` — requester withdraws

No body. Response `200` → `Approval` with `status: "cancelled"`. `404` if it is not the caller's request, `409 NOT_PENDING` if it was already decided.

### 4.8 `GET /api/approvals/counts` — tab badge

`{ "all": 4, "pending": 1, "approved": 2, "rejected": 1, "cancelled": 0, "actionable": 1 }` — use `actionable` for the red badge.

## 5. Error format (same as the rest of the API)

```json
{ "error": { "code": "BAD_REQUEST", "message": "Finance: you cannot be an approver on your own request", "details": null } }
```

`message` is written for the end user — safe to show in a toast. `401 UNAUTHORIZED` = token missing/expired → refresh and retry (the app's API client already does this).

## 6. Realtime + push

The app's Socket.IO connection (same server, handshake `auth: { token: accessToken }`) receives:

| event | payload | sent to | what to do |
|---|---|---|---|
| `approval:new` | `{ id }` | everyone on the level whose turn has just started | refetch list + `/counts` (badge +1) |
| `approval:update` | `{ id }` | the requester and everyone the request has reached | refetch that item / the list |

Payloads carry only the id — always refetch through REST.

Push notifications carry `data: { type: "approval", id: "<approvalId>" }`:

| who | when | title · body |
|---|---|---|
| everyone on the next level | the request reaches them | "Rohan Mehta needs your approval" · title |
| requester | someone approved and the level moved on | "Faiz Patel approved · level 1 of 3" · "title — now with Kiran Rao, Afshin Dhanani" |
| requester | someone approved but the level (mode `all`) is still open | "Faiz Patel approved · level 1 of 3" · "title — still waiting on Pravesh Jha" |
| requester | fully approved | "✅ Request approved" |
| requester | rejected | "❌ Rejected by Faiz Patel" · note |

On tap, route `type === "approval"` to the Approvals tab and open the sheet for `id`.

## 7. Try it with curl

```bash
BASE=https://kbiz360.duckdns.org
ACCESS=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"you@example.com","password":"…"}' | jq -r .accessToken)

curl -s $BASE/api/approvals/hierarchy -H "Authorization: Bearer $ACCESS" | jq '.levels, .approvers[0], .suggestedLevels'
curl -s "$BASE/api/approvals/approvers?q=faiz" -H "Authorization: Bearer $ACCESS" | jq

curl -s -X POST $BASE/api/approvals -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' -d '{
  "title": "Test approval — please ignore",
  "details": "Integration test",
  "levels": [
    { "label": "Managers", "mode": "all", "approverIds": ["<id>", "<id>"] },
    { "mode": "any", "approverIds": ["<id>", "<id>"] },
    { "approverIds": ["<id>"] }
  ]}' | jq

curl -s "$BASE/api/approvals?status=pending" -H "Authorization: Bearer $ACCESS" | jq
curl -s -X PUT $BASE/api/approvals/<id>/decision -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"action":"approve"}' | jq
curl -s -X PUT $BASE/api/approvals/<id>/cancel -H "Authorization: Bearer $ACCESS" | jq
```

This is the **live production** server: a request you create really notifies the people you pick. While testing, put "test" in the title, pick colleagues who know, and withdraw it afterwards with `/cancel`. To see the whole chain move you need to log in as each approver in turn (each login needs App Access enabled in the ERP).

## 8. Notes for the screens

- **New request form** = title, details, then the level builder: a list of level cards, each with an editable name, a people multi-select (from `approvers`), an "everyone / anyone" toggle (`mode`), and remove. "Add level" appends one; the badge shows `levels.length` steps. Validate `levels.*` limits client-side. Submit is disabled until every level has at least one person.
- **Detail sheet "Approval hierarchy"**: one section per `levels[]` (heading = `label` + status pill + "2 of 3" from `approvedCount`/`requiredCount` when mode is `all` and there are several people), one row per `approvers[]` (avatar, name, status icon, `note` under a decided row).
- **Buttons**: Approve / Reject only when `canAct`; Withdraw only when `canCancel`.
- **After any write** (create / decision / cancel) the response is the fresh `Approval` — update local state from it rather than refetching.
- **Dates**: ISO UTC — format on the device.

## 9. Migrating the current app build

The build shipped on 2026-09-21 keeps working unchanged (the server still accepts `approvers[]` and still returns `steps[]`). To adopt N levels:

1. `src/api/approvals.ts`: add the `levels`/`ApproverCandidate` types from §3, `ApprovalCreateRequest.levels`, `getApprovalApprovers(q?)`, and read `hierarchy.levels` / `hierarchy.approvers` / `hierarchy.suggestedLevels`.
2. `RequestForm`: replace the three fixed dropdowns with the level builder (§8) and send `levels[]`.
3. `ApprovalDetail`: render `levels[]` instead of `steps[]` (the flattened `steps[]` still works meanwhile; note `steps[].order` is now a running row number and `steps[].level` is the level).
4. Card: "waiting on" from `currentApprovers`.
5. `ApprovalStepKey` is no longer a closed union — `levels[].key` is `string | null`.

Nothing in the list/counts/decision/cancel calls changes.
