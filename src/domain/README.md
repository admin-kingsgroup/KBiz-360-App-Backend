# `src/domain/` — verbatim port of the frontend source of truth

These files are **lifted byte-for-byte** from `Frontend/src/*` and are the canonical business
logic. **Do not edit them to "improve" behavior.** They exist so the backend reproduces the
frontend exactly (RULE #1 / RULE #2). The same Jest specs run against this copy (`__tests__/`).

| Backend path | Copied from | Notes |
|---|---|---|
| `types/*` | `Frontend/src/types/*` | verbatim |
| `constants/*` | `Frontend/src/constants/*` | verbatim |
| `logic/*` | `Frontend/src/logic/*` | verbatim (access, accessFilters, canSee, reminderGrouping, attendance, geo, validation, format) |
| `data/*` | `Frontend/src/data/*` | verbatim — doubles as the seed source of truth |
| `theme/colors.ts` | `Frontend/src/theme/colors.ts` | verbatim (pure hex palette) |
| `services/notifications/routes.ts` | same | verbatim (pure route map) |
| `navigation/guards.ts` | `Frontend/src/navigation/guards.ts` | **pure subset** — `resolveGate` + `allPermsGranted` copied verbatim; the `useGate()` React/Zustand hook is omitted |

## How the backend consumes this
- `AccessService` (Phase 2) wraps `deriveAccess` / `makeAccessFilters` / `makeCanSee` — no rewrites.
- The Prisma seed (`prisma/seed.ts`) imports `data/*` so DB rows equal the mock data exactly.
- Request/response DTOs map onto `types/*`.

## Re-sync policy
If `Frontend/src/logic|constants|types` changes (with a proving test), re-copy the changed file
here and re-run `npm test`. Never let the two drift silently.
