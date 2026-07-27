# Database least-privilege — CRM read-only boundary (SEC-2)

The backend shares one Atlas cluster with the CRM/ERP: a read-only **CRM** database (source of truth
for the ERP) and the app-owned **`kb360_app`** database. Historically it connected as the cluster
**admin** user, so any bug could write to (or drop) the CRM. This document is the **infrastructure
half** of the fix; the code half is already implemented (see "Code safeguards" below).

## Code safeguards (already implemented — no action needed)

- **Read-only guard in code.** `crm.repo.ts` reads through `guardReadOnly(...)`: any write op
  (`insertOne`, `updateOne`, `deleteMany`, `bulkWrite`, `drop`, …) on a CRM collection **throws**,
  regardless of what the DB credential permits. Accidental CRM mutation is impossible from the read
  path. Unit-tested in `src/mongo/__tests__/crmReadOnlyGuard.test.ts`.
- **Explicit write path.** The only sanctioned CRM writes (7 provisioning methods: `createUser`,
  `updateUser`, `createCompany`, `createBranch`, `addUserBranch`, `removeUserBranch`,
  `setRolePermissions`) go through `crmWriteDb()` — a separate, greppable, separately-credentialable
  handle. Nothing else in the codebase writes to the CRM.
- **Connection separation.** `connection.ts` exposes `crmDb()` (read), `crmWriteDb()` (sanctioned
  writes), and `appDb()` (app writes). `crmWriteDb()` uses `CRM_WRITE_MONGODB_URI` when set, else
  falls back to the main connection (backward compatible).

## Infrastructure tasks (must be done in Atlas — cannot be done in code)

### 1. App user — replace the cluster-admin credential
Create a database user used by `MONGODB_URI` with **least privilege**:

| Database        | Role        |
|-----------------|-------------|
| `kb360_app`     | `readWrite` |
| `test` (CRM_DB) | `read`      |

Example custom role / grants (Atlas UI → Database Access → Add New Database User → Custom Roles, or
via the API). Do **not** grant `atlasAdmin`, `dbAdminAnyDatabase`, `readWriteAnyDatabase`, or `root`.

```
// app-user: readWrite on the app DB, read-only on the CRM DB
db.grantRolesToUser("kb360_app_user", [
  { role: "readWrite", db: "kb360_app" },
  { role: "read",      db: "test" }        // CRM_DB — READ ONLY
])
```

Then set `MONGODB_URI` to this user and **rotate/retire the admin credential** the app currently uses.

### 2. (Optional) CRM-write user — for in-app admin provisioning
The app's admin screens can create/update CRM users, roles, companies and branches. If you want those
to keep working **after** step 1 (which makes the app user read-only on the CRM), create a second,
narrowly-scoped user for `CRM_WRITE_MONGODB_URI`:

| Database        | Role        | Scope                                             |
|-----------------|-------------|---------------------------------------------------|
| `test` (CRM_DB) | `readWrite` | ideally collection-scoped: users/roles/companies/branches |

```
// crm-write-user: readWrite on the CRM DB (scope to the 4 collections if your tier supports it)
db.grantRolesToUser("kb360_crm_writer", [
  { role: "readWrite", db: "test" }
])
```

Set `CRM_WRITE_MONGODB_URI` to this user. **If you leave `CRM_WRITE_MONGODB_URI` unset**, the app user
(step 1) must retain write access to the CRM for provisioning to work — i.e. you get the code-level
read-only guard but not credential-level isolation for the 7 provisioning writes. Choosing to disable
in-app CRM provisioning entirely is also valid: leave `CRM_WRITE_MONGODB_URI` unset and the app user
read-only on the CRM; the 7 provisioning calls will then fail at the driver, and provisioning is done
via the CRM/ERP directly.

## Rollout

**Fresh deployment:** create both users (or just the app user if not using in-app provisioning), set
`MONGODB_URI` (+ optional `CRM_WRITE_MONGODB_URI`), deploy.

**Existing deployment upgrade (zero code risk — the code is backward compatible):**
1. Deploy this release first — behaviour is unchanged (writes still use the current credential).
2. Create the least-privilege app user (step 1) and, if needed, the CRM-write user (step 2).
3. Point `MONGODB_URI` at the new app user; set `CRM_WRITE_MONGODB_URI` if using step 2; restart.
4. Verify: login, directory reads, an app write (send a chat message), and — if step 2 is used — an
   admin user edit. Then rotate/disable the old admin credential.
