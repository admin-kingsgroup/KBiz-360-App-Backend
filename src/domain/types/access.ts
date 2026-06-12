import type { RoleKey } from './roles';
import type { GrantId } from './user';

// Runtime, DERIVED object. `null` means unrestricted (Super Admin).
export interface AccessControl {
  isSuper: boolean;
  role: RoleKey;
  name: string;
  bizIds: string[] | null;
  branches: string[] | null;   // branch codes
  groups: GrantId[] | null;
  depts: GrantId[] | null;
  alerts: GrantId[] | null;
  canManage: boolean;
}

export interface Permissions {
  location: boolean;
  notifications: boolean;
  network: boolean;
}
