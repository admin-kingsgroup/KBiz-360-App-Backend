import type { AccessControl } from '../types';

// Visibility predicates used by Groups / Departments / System-Alerts / business pills.
// Extracted verbatim from GroupsList, DepartmentsList, PulseInline, BusinessSelectorSheet.
// `access` null/undefined is treated as Super (matches `isSuper = !access || access.isSuper`).
export function makeAccessFilters(access: AccessControl | null | undefined) {
  const isSuper = !access || access.isSuper;
  const a = access as AccessControl;
  return {
    isSuper,
    bizOK: (id: string): boolean => isSuper || (a.bizIds || []).includes(id),
    brOK: (code: string): boolean => isSuper || (a.branches || []).includes(code),
    grpOK: (code: string, name: string): boolean =>
      isSuper || (a.groups || []).includes(`${code}-${name}`),
    deptOK: (code: string, name: string): boolean =>
      isSuper || (a.depts || []).includes(`${code}-${name}`) || (a.depts || []).includes(name),
    alertOK: (code: string | null, mod: string): boolean =>
      isSuper || (!!code && (a.alerts || []).includes(`${code}-${mod}`)) || (a.alerts || []).includes(mod),
  };
}
