# Approvals API — frontend integration guide

Backend for the **Approvals** tab (New request · My approvals · request detail sheet) of KBiz 360 Smart Connect.

| | |
|---|---|
| Base URL (production) | `https://kbiz360.duckdns.org` |
| Prefix | `/api/approvals` |
| Auth | `Authorization: Bearer <accessToken>` on every call — the same token the rest of the app already uses (`POST /api/auth/login` → `accessToken`, 15 min, refresh with `POST /api/auth/refresh`) |
| Format | JSON in, JSON out. Dates are ISO 8601 strings (UTC). IDs are 24-char hex strings. |
| Who is "me" | Always the logged-in user from the token. No endpoint takes a `userId` for the caller. |

## 1. How the approval chain works

A request is reviewed by up to **three people, strictly one after another**:

```
Requester ──► 1. Branch manager ──► 2. Company manager ──► 3. Business owner ──► APPROVED
                    │ reject               │ reject                │ reject
                    └──────────────────────┴───────────────────────┴──► REJECTED (chain stops)
```

- The requester picks **one person per step** on the New request form. The server tells you which steps exist and who can be picked (`GET /hierarchy`).
- The request goes to **step 1 only**. Step 2 does not see it — not in their list, not by id — until step 1 approves. Step 3 sees it only after step 2 approves.
- **Approve** on the last step → the request is `approved`. **Reject** on any step → the request is `rejected` immediately and the remaining steps are `skipped` (those people never see it).
- Only the person whose **turn** it is can decide. The response field `canAct` tells you exactly that — show the Approve / Reject buttons only when `canAct === true`.
- The requester can **withdraw** a request while it is still pending (`canCancel === true`).

The number of steps is **not always 3** — render whatever `GET /hierarchy` returns and use its `totalSteps` for the "3 steps" badge:

| Logged-in user is a… | Steps they get |
|---|---|
| Employee / HOD | Branch manager → Company manager → Business owner |
| Branch manager | Company manager → Business owner |
| Company manager | Business owner |
| Business owner (super admin) | Business owner (another owner) |

A step with nobody available is left out (e.g. a branch whose manager is not on the app goes straight to Company manager). Branch-manager candidates are only managers of the requester's own branch.

### Statuses

**Request `status`** — drives the pill on the card and the filter chips:

| value | meaning | pill |
|---|---|---|
| `pending` | still travelling the chain | Pending (amber) |
| `approved` | every step approved | Approved (green) |
| `rejected` | someone rejected it | Rejected (red) |
| `cancelled` | the requester withdrew it | (only appears under "All requests") |

**Step `status`** — drives the icon on each row of "Approval hierarchy" in the detail sheet:

| value | meaning | suggested icon |
|---|---|---|
| `pending` | it is this person's turn right now (`isCurrent: true`) | amber clock |
| `waiting` | not reached yet | amber/grey clock |
| `approved` | this person approved | green check |
| `rejected` | this person rejected | red cross |
| `skipped` | never reached — the request ended before it | grey dash |

## 2. Screen → endpoint map

| Screen | Call |
|---|---|
| **New request** tab opens | `GET /api/approvals/hierarchy` → render one dropdown per `steps[]`, badge = `totalSteps` |
| New request → Submit | `POST /api/approvals` |
| **My approvals** tab, chip "All requests" | `GET /api/approvals` |
| Chip Pending / Approved / Rejected | `GET /api/approvals?status=pending` (`approved`, `rejected`) |
| Tap a card → detail sheet | use the list item you already have (it contains the full `steps[]`), or `GET /api/approvals/:id` to refresh |
| **Approve** / **Reject** button | `PUT /api/approvals/:id/decision` |
| Withdraw (optional) | `PUT /api/approvals/:id/cancel` |
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

type ApprovalStep = {
  order: number;           // 1, 2, 3
  key: 'branch_manager' | 'company_manager' | 'business_owner';
  label: string;           // "Branch manager"
  approver: Person;
  status: 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped';
  isCurrent: boolean;      // the request is sitting on this step right now
  decidedAt: string | null;
  note: string;            // what the approver wrote ("" if nothing)
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
  totalSteps: number;
  currentStep: number | null;     // 1-based; null once the request is final
  currentApprover: Person | null; // who it is waiting on; null once final
  steps: ApprovalStep[];
  // relative to the logged-in user:
  isMine: boolean;         // I raised it
  canAct: boolean;         // it is MY turn → show Approve / Reject
  canCancel: boolean;      // I can withdraw it
  myDecision: 'approved' | 'rejected' | null; // what I decided on my own step
};
```

Card subtitle in the mock ("Rohan Mehta · Salary") = `requester.name · category`. Card date = `submittedAt`.

## 4. Endpoints

### 4.1 `GET /api/approvals/hierarchy` — data for the New request form

Response `200`:

```json
{
  "totalSteps": 3,
  "steps": [
    {
      "order": 1,
      "key": "branch_manager",
      "label": "Branch manager",
      "placeholder": "Select branch manager",
      "required": true,
      "defaultApproverId": null,
      "candidates": [
        { "id": "66f1…a01", "name": "Pravesh Jha", "initials": "PJ", "color": "#37B6A4", "avatar": null, "position": "Branch Manager" }
      ]
    },
    { "order": 2, "key": "company_manager", "label": "Company manager", "placeholder": "Select company manager", "required": true, "defaultApproverId": null, "candidates": [ … ] },
    { "order": 3, "key": "business_owner",  "label": "Business owner",  "placeholder": "Select business owner",  "required": true, "defaultApproverId": null, "candidates": [ … ] }
  ],
  "categories": ["Salary", "Holiday", "Leave", "Expense", "Purchase", "Travel", "HR", "General"],
  "limits": { "title": 120, "details": 2000, "note": 500 }
}
```

- Render `steps` in the order given. Every returned step is required.
- `defaultApproverId` is set when a step has exactly one candidate — pre-select it.
- `totalSteps: 0` / `steps: []` means nobody above this user can approve; disable Submit and show a message.
- `categories` is optional to use — see `category` below.

### 4.2 `POST /api/approvals` — submit a request

Body:

```json
{
  "title": "Salary release approval",
  "details": "Requesting approval to release the September salary payment for the Ahmedabad team.",
  "category": "Salary",
  "approvers": [
    { "step": "branch_manager",  "userId": "66f1…a01" },
    { "step": "company_manager", "userId": "66f1…b02" },
    { "step": "business_owner",  "userId": "66f1…c03" }
  ]
}
```

| field | rules |
|---|---|
| `title` | required, 1–120 chars |
| `details` | required, 1–2000 chars |
| `category` | **optional**. If you do not send it, the server reads it off the title ("Salary release approval" → `Salary`, "Client visit expense approval" → `Expense`, otherwise `General`). Send it only if you add a category picker. |
| `approvers` | one entry per step returned by `/hierarchy`; `step` = that step's `key`, `userId` = one of that step's `candidates`. Array order does not matter — the server stores the chain in hierarchy order. |

Response `201` → the created `Approval` (`status: "pending"`, `currentStep: 1`, step 1 `pending`, the rest `waiting`).

Errors: `400 VALIDATION` (missing/too-long field), `400 BAD_REQUEST` (a step left empty, a person who is not a candidate for that step, an unknown step key), `422 NO_APPROVERS` (the user has no hierarchy).

### 4.3 `GET /api/approvals` — the My approvals list

Query (all optional):

| param | values | default | meaning |
|---|---|---|---|
| `scope` | `all` \| `mine` \| `assigned` \| `actionable` | `all` | `all` = requests I raised **+** requests that have reached me as an approver · `mine` = only ones I raised · `assigned` = only ones that reached me · `actionable` = only ones waiting on **me** right now |
| `status` | `pending` \| `approved` \| `rejected` \| `cancelled` | — | the filter chips |
| `page` | 1… | `1` | |
| `limit` | 1–100 | `50` | |

Response `200`:

```json
{
  "scope": "all",
  "status": null,
  "page": 1,
  "limit": 50,
  "total": 4,
  "hasMore": false,
  "counts": { "all": 4, "pending": 1, "approved": 2, "rejected": 1, "cancelled": 0, "actionable": 1 },
  "items": [ /* Approval[] — newest first, each with its full steps[] */ ]
}
```

- `counts` is always for the current `scope` **ignoring** the `status` filter, so you can show numbers on all four chips from one response. `counts.actionable` = how many are waiting on me right now.
- The mock's single list = `scope=all`. If you later want two sections ("Needs my approval" / "My requests"), use `scope=actionable` and `scope=mine`.

### 4.4 `GET /api/approvals/:id` — one request (detail sheet)

Response `200` → `Approval`.

`404 NOT_FOUND` if the request does not exist **or the user is not allowed to see it yet** (a later approver the chain has not reached gets 404 on purpose). Allowed: the requester, any approver the request has reached, and super admins.

### 4.5 `PUT /api/approvals/:id/decision` — Approve / Reject

Body:

```json
{ "action": "approve", "note": "Looks fine" }
```

`action`: `"approve"` | `"reject"`. `note`: optional, max 500 chars (shown to the requester; recommended on reject).

Response `200` → the updated `Approval`. After an approve on a non-final step you will see `status: "pending"`, `currentStep` moved forward, `canAct: false`, `myDecision: "approved"`. Replace the item in your list with the response.

| status | `error.code` | when |
|---|---|---|
| 404 | `NOT_FOUND` | no such request, or the user is not on its chain |
| 409 | `NOT_YOUR_TURN` | an earlier step has not approved yet |
| 409 | `ALREADY_DECIDED` | this user already decided their step |
| 409 | `NOT_PENDING` | the request is already approved / rejected / cancelled |
| 409 | `STALE` | someone changed it at the same moment — refetch and retry |

If you only show the buttons when `canAct` is true, users will practically never hit the 409s; on any 409, refetch the item.

### 4.6 `PUT /api/approvals/:id/cancel` — requester withdraws

No body. Response `200` → `Approval` with `status: "cancelled"`. `404` if it is not the caller's request, `409 NOT_PENDING` if it was already decided.

### 4.7 `GET /api/approvals/counts` — tab badge

Response `200`:

```json
{ "all": 4, "pending": 1, "approved": 2, "rejected": 1, "cancelled": 0, "actionable": 1 }
```

Use `actionable` for the red badge on the Approvals tab icon.

## 5. Error format (same as the rest of the API)

```json
{ "error": { "code": "BAD_REQUEST", "message": "Select an approver for: Company manager", "details": null } }
```

`message` is written for the end user — it is safe to show in a toast. `401 UNAUTHORIZED` = token missing/expired → refresh the token and retry (the app's existing API client already does this).

## 6. Realtime + push (optional but recommended)

The app's existing Socket.IO connection (same server, handshake `auth: { token: accessToken }`) receives:

| event | payload | sent to | what to do |
|---|---|---|---|
| `approval:new` | `{ id }` | the approver whose turn has just started | refetch list + `/counts` (badge +1) |
| `approval:update` | `{ id }` | the requester and every approver it has reached | refetch that item / the list |

Payloads carry only the id — always refetch through REST.

Push notifications are sent automatically with `data: { type: "approval", id: "<approvalId>" }`:

| who | when | title |
|---|---|---|
| next approver | the request reaches them | "Rohan Mehta needs your approval" |
| requester | a step approved, moved on | "Faiz Patel approved · step 1 of 3" |
| requester | fully approved | "✅ Request approved" |
| requester | rejected | "❌ Rejected by Faiz Patel" |

On tap, route `type === "approval"` to the Approvals tab and open the sheet for `id` (add the case in `services/notifications/routes.ts`).

## 7. Try it with curl

```bash
BASE=https://kbiz360.duckdns.org
ACCESS=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"you@example.com","password":"…"}' | jq -r .accessToken)

curl -s $BASE/api/approvals/hierarchy -H "Authorization: Bearer $ACCESS" | jq

curl -s -X POST $BASE/api/approvals -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' -d '{
  "title": "Test approval — please ignore",
  "details": "Integration test",
  "approvers": [
    {"step":"branch_manager","userId":"<id from hierarchy>"},
    {"step":"company_manager","userId":"<id>"},
    {"step":"business_owner","userId":"<id>"}
  ]}' | jq

curl -s "$BASE/api/approvals?status=pending" -H "Authorization: Bearer $ACCESS" | jq
curl -s -X PUT $BASE/api/approvals/<id>/decision -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"action":"approve"}' | jq
curl -s -X PUT $BASE/api/approvals/<id>/cancel -H "Authorization: Bearer $ACCESS" | jq
```

This is the **live production** server: a request you create really notifies the approvers you pick. While testing, put "test" in the title, pick colleagues who know, and withdraw it afterwards with `/cancel`. To see the whole chain move you need to log in as each approver in turn (each login needs App Access enabled in the ERP).

## 8. Notes for the screens

- **Form validation**: Title and Details required; every dropdown returned by `/hierarchy` required. Enforce `limits` client-side to avoid a 400.
- **Dates**: `submittedAt` is UTC ISO — format on the device ("Sep 17, 2026").
- **Detail sheet "Approval hierarchy"**: map `steps[]` → row label = `label`, right side = `approver.name`, icon from `status`. Show `note` under a decided row when it is not empty.
- **Buttons**: show Approve / Reject only when `canAct`. Show Withdraw only when `canCancel`.
- **After any write** (create / decision / cancel) the response is the fresh `Approval` — update local state from it rather than refetching.
