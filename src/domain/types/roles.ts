// Role hierarchy — top (most access) to bottom. Order matches ROLE_OPTIONS.
export type RoleKey =
  | 'SUPER_ADMIN'
  | 'DIRECTOR'
  | 'GENERAL_MANAGER'
  | 'BRANCH_MANAGER'
  | 'HOD'
  | 'EMPLOYEE';

// Icon intentionally excluded from the data type (icons live in a UI-only icon map).
export interface RoleDef {
  key: RoleKey;
  label: string;
  badge: string;
  color: string;
  scope: string;
  sees: string;
  perms: string[];
}
