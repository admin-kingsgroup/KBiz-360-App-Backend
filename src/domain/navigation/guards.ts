// PURE SUBSET of Frontend/src/navigation/guards.ts — the two pure decision functions are copied
// VERBATIM. The frontend's `useGate()` hook is intentionally omitted (it imports Zustand stores +
// React and is UI-only). Backend route guards will call resolveGate/allPermsGranted directly.

export type GateTarget = 'login' | 'permissions' | 'app';

// Pure decision function — easy to unit test, no router/UI dependency.
// Mirrors the source flow: signed-out -> login; signed-in but perms ungranted -> permissions; else app.
export function resolveGate(input: {
  isAuthenticated: boolean;
  allPermsGranted: boolean;
}): GateTarget {
  if (!input.isAuthenticated) return 'login';
  if (!input.allPermsGranted) return 'permissions';
  return 'app';
}

export function allPermsGranted(p: { location: boolean; notifications: boolean; network: boolean }): boolean {
  return p.location && p.notifications && p.network;
}
