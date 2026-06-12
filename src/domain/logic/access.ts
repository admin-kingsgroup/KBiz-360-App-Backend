import type { AccessControl, User } from '../types';

// Derive the runtime access object from the effective user (real user, or "view as" user).
// Extracted verbatim from App: effUser -> access. `null` fields = unrestricted (Super Admin).
export function deriveAccess(effUser: Pick<User, 'role' | 'name' | 'bizId' | 'branches' | 'accessGroups' | 'accessDepts' | 'accessAlerts'>): AccessControl {
  const accIsSuper = effUser.role === 'SUPER_ADMIN';
  return {
    isSuper: accIsSuper,
    role: effUser.role,
    name: effUser.name,
    bizIds: accIsSuper ? null : (effUser.bizId ? [effUser.bizId] : []),
    branches: accIsSuper ? null : (effUser.branches || []),
    groups: accIsSuper ? null : (effUser.accessGroups || []),
    depts: accIsSuper ? null : (effUser.accessDepts || []),
    alerts: accIsSuper ? null : (effUser.accessAlerts || []),
    canManage: accIsSuper || effUser.role === 'DIRECTOR',
  };
}
