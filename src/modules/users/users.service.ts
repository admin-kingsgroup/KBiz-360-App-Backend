import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { AppError, NotFound, BadRequest } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { toDomainUser } from '../access/access.service';
import { validateUserDraft, type UserDraft, type ValidationCatalogs, type ValidationResult } from '../../domain/logic/validation';
import { branches, businessDepts } from '../../domain/data/businesses';
import { BIZ_MODULES, MODULES } from '../../domain/constants/modules';
import { ROLE_DEFS } from '../../domain/constants/roles';
import type { User as DomainUser } from '../../domain/types';

// Validation catalogs are the SAME reference data the frontend uses → validateUserDraft behaves
// identically here (only tk has branches; depts/modules per business). RULE #1/#2.
const catalogs: ValidationCatalogs = {
  branches,
  businessDepts,
  bizModules: BIZ_MODULES,
  modules: MODULES,
};

// Exposed for unit tests: the exact validation the Users API enforces.
export function validateDraft(draft: UserDraft): ValidationResult {
  return validateUserDraft(draft, catalogs);
}

// Display initials when none are supplied (admin form derives them in the app).
export function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? '';
  return (first + second).toUpperCase();
}

function draftFromUser(u: {
  name: string; email: string | null; role: DomainUser['role']; bizId: string | null;
  branches: string[]; accessGroups: string[]; accessDepts: string[]; accessAlerts: string[];
}): UserDraft {
  return {
    name: u.name,
    email: u.email ?? '',
    role: u.role,
    bizId: u.bizId,
    branches: u.branches,
    accessGroups: u.accessGroups,
    accessDepts: u.accessDepts,
    accessAlerts: u.accessAlerts,
  };
}

export const usersService = {
  async list(): Promise<DomainUser[]> {
    const rows = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toDomainUser);
  },

  async getById(id: string): Promise<DomainUser> {
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u) throw NotFound('User not found');
    return toDomainUser(u);
  },

  async create(draft: UserDraft, actorId: string): Promise<DomainUser> {
    const result = validateDraft(draft);
    if (!result.valid) throw new AppError(400, 'Invalid user', 'VALIDATION', result);
    try {
      const created = await prisma.user.create({
        data: {
          name: draft.name,
          email: draft.email || null,
          initials: deriveInitials(draft.name),
          color: ROLE_DEFS[draft.role].color,
          role: draft.role,
          bizId: draft.bizId,
          branches: draft.branches,
          accessGroups: draft.accessGroups,
          accessDepts: draft.accessDepts,
          accessAlerts: draft.accessAlerts,
        },
      });
      await writeAudit({ actorId, action: 'CREATE', entity: 'User', entityId: created.id, after: toDomainUser(created) });
      return toDomainUser(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(409, 'Email already in use', 'EMAIL_TAKEN');
      }
      throw err;
    }
  },

  async update(id: string, patch: Partial<UserDraft>, actorId: string): Promise<DomainUser> {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw NotFound('User not found');

    const merged: UserDraft = { ...draftFromUser(existing), ...patch };
    const result = validateDraft(merged);
    if (!result.valid) throw new AppError(400, 'Invalid user update', 'VALIDATION', result);

    const before = toDomainUser(existing);
    try {
      const updated = await prisma.user.update({
        where: { id },
        data: {
          name: merged.name,
          email: merged.email || null,
          initials: deriveInitials(merged.name),
          color: ROLE_DEFS[merged.role].color,
          role: merged.role,
          bizId: merged.bizId,
          branches: merged.branches,
          accessGroups: merged.accessGroups,
          accessDepts: merged.accessDepts,
          accessAlerts: merged.accessAlerts,
        },
      });
      await writeAudit({ actorId, action: 'UPDATE', entity: 'User', entityId: id, before, after: toDomainUser(updated) });
      return toDomainUser(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(409, 'Email already in use', 'EMAIL_TAKEN');
      }
      throw err;
    }
  },

  async remove(id: string, actorId: string): Promise<void> {
    if (id === actorId) throw BadRequest('You cannot delete your own account');
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw NotFound('User not found');
    const before = toDomainUser(existing);
    await prisma.user.delete({ where: { id } });
    await writeAudit({ actorId, action: 'DELETE', entity: 'User', entityId: id, before });
  },
};
