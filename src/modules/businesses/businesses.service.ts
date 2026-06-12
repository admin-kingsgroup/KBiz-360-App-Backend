import type { Business as PBusiness, Branch as PBranch, Group as PGroup, Department as PDepartment } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { makeAccessFilters } from '../../domain/logic/accessFilters';
import { Forbidden, NotFound } from '../../common/errors';
import type { AccessControl } from '../../domain/types';
// Canonical DISPLAY ORDER comes from the same reference arrays the seed used (tk,qa,…; branch &
// group order per the source). Filtering uses makeAccessFilters verbatim → identical to homeSegments.
import { businesses as bizRef, branches as brRef, businessDepts as deptRef } from '../../domain/data/businesses';

const bizOrder = new Map(bizRef.map((b, i) => [b.id, i] as const));
const branchOrder = new Map(brRef.map((b, i) => [b.id, i] as const));
const groupOrderByBranch = new Map(brRef.map((b) => [b.id, new Map(b.groups.map((g, i) => [g.id, i] as const))] as const));
const deptOrder = new Map(
  Object.entries(deptRef).map(([biz, ds]) => [biz, new Map(ds.map((d, i) => [d.id, i] as const))] as const),
);
const at = (m: Map<string, number> | undefined, id: string): number => m?.get(id) ?? 999;

function mapBusiness(b: PBusiness) {
  return {
    id: b.id, code: b.code, name: b.name,
    industry: b.industry ?? undefined, shortInd: b.shortInd ?? undefined,
    color: b.color, tint: b.tint ?? undefined,
    branches: b.branchCount, users: b.userCount ?? undefined,
    status: b.status, unread: b.unread ?? undefined, active: b.active ?? undefined,
  };
}
const mapBranch = (br: PBranch) => ({
  id: br.id, code: br.code, city: br.city, country: br.country, flag: br.flag,
  tz: br.tz, lat: br.lat, lng: br.lng, radius: br.radius, wifi: br.wifi, color: br.color,
});
const mapGroup = (g: PGroup) => ({ id: g.id, name: g.name, icon: g.icon, color: g.color });
const mapDept = (d: PDepartment) => ({ id: d.id, name: d.name, icon: d.icon, color: d.color });

export const businessesService = {
  // Business pills — bizOK (Super sees all).
  async listBusinesses(access: AccessControl) {
    const f = makeAccessFilters(access);
    const rows = await prisma.business.findMany();
    return rows.filter((b) => f.bizOK(b.id)).sort((a, b) => at(bizOrder, a.id) - at(bizOrder, b.id)).map(mapBusiness);
  },

  async getBusiness(access: AccessControl, id: string) {
    const f = makeAccessFilters(access);
    const b = await prisma.business.findUnique({ where: { id } });
    if (!b) throw NotFound('Business not found');
    if (!f.bizOK(b.id)) throw Forbidden('Business not in your scope');
    return mapBusiness(b);
  },

  // Branches of a business — brOK.
  async listBranches(access: AccessControl, bizId: string) {
    const f = makeAccessFilters(access);
    const b = await prisma.business.findUnique({ where: { id: bizId } });
    if (!b) throw NotFound('Business not found');
    if (!f.bizOK(b.id)) throw Forbidden('Business not in your scope');
    const rows = await prisma.branch.findMany({ where: { bizId } });
    return rows.filter((br) => f.brOK(br.code)).sort((x, y) => at(branchOrder, x.id) - at(branchOrder, y.id)).map(mapBranch);
  },

  // Groups of a branch — grpOK(branch.code, group.name).
  async listGroups(access: AccessControl, branchId: string) {
    const f = makeAccessFilters(access);
    const br = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!br) throw NotFound('Branch not found');
    if (!f.brOK(br.code)) throw Forbidden('Branch not in your scope');
    const order = groupOrderByBranch.get(branchId);
    const rows = await prisma.group.findMany({ where: { branchId } });
    return rows.filter((g) => f.grpOK(br.code, g.name)).sort((a, b) => at(order, a.id) - at(order, b.id)).map(mapGroup);
  },

  // Departments visible for a group's BRANCH — deptOK(branch.code, dept.name). Departments are
  // business-owned but branch-scoped in the UI; the group identifies the branch (brief route).
  async listDepartmentsForGroup(access: AccessControl, groupId: string) {
    const f = makeAccessFilters(access);
    const g = await prisma.group.findUnique({ where: { id: groupId }, include: { branch: true } });
    if (!g) throw NotFound('Group not found');
    const br = g.branch;
    if (!f.brOK(br.code)) throw Forbidden('Branch not in your scope');
    const order = deptOrder.get(br.bizId);
    const rows = await prisma.department.findMany({ where: { bizId: br.bizId } });
    return rows.filter((d) => f.deptOK(br.code, d.name)).sort((a, b) => at(order, a.id) - at(order, b.id)).map(mapDept);
  },
};
