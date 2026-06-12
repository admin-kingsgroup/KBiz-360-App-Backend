import type { User as PrismaUser } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { deriveAccess } from '../../domain/logic/access';
import { makeAccessFilters } from '../../domain/logic/accessFilters';
import { makeCanSee } from '../../domain/logic/canSee';
import type { AccessControl, PersonMeta, ReminderViewer, User as DomainUser } from '../../domain/types';

// Maps a Prisma User row → the frontend `User` shape that deriveAccess() expects. The grant arrays
// are the EXACT composite strings stored verbatim, so deriveAccess produces identical output.
export function toDomainUser(u: PrismaUser): DomainUser {
  return {
    id: u.id,
    name: u.name,
    initials: u.initials,
    color: u.color,
    role: u.role as DomainUser['role'],
    email: u.email ?? undefined,
    bizId: u.bizId,
    branches: u.branches,
    accessGroups: u.accessGroups,
    accessDepts: u.accessDepts,
    accessAlerts: u.accessAlerts,
    attendance: u.attendanceEnabled ?? undefined,
    scopeLine: u.scopeLine ?? undefined,
    login: u.loginLabel ?? undefined,
  };
}

// Centralizes ALL access derivation. It NEVER reimplements rules — it only wraps the verbatim
// ported pure functions (deriveAccess / makeAccessFilters / makeCanSee). See RULE #1 / RULE #2.
export class AccessService {
  // ── Access space (User / adminUsers) ──
  accessForUser(u: PrismaUser): AccessControl {
    return deriveAccess(toDomainUser(u));
  }

  filtersForUser(u: PrismaUser): ReturnType<typeof makeAccessFilters> {
    return makeAccessFilters(this.accessForUser(u));
  }

  async accessForUserId(id: string): Promise<AccessControl | null> {
    const u = await prisma.user.findUnique({ where: { id } });
    return u ? deriveAccess(toDomainUser(u)) : null;
  }

  // ── canSee space (ReminderViewer / PERSON_META) — separate identity, stored role/dept ──
  async personMeta(): Promise<Record<string, PersonMeta>> {
    const rows = await prisma.reminderViewer.findMany();
    const map: Record<string, PersonMeta> = {};
    for (const r of rows) {
      map[r.id] = { role: r.role as PersonMeta['role'], branches: r.branches, dept: r.dept };
    }
    return map;
  }

  async canSeeFor(viewer: ReminderViewer): Promise<(targetId: string) => boolean> {
    return makeCanSee(viewer, await this.personMeta());
  }
}

export const accessService = new AccessService();
