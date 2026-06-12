import type { AuditLog as PAudit } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { NotFound } from '../../common/errors';

function mapAudit(a: PAudit) {
  return {
    id: a.id,
    actorId: a.actorId ?? undefined,
    action: a.action,
    entity: a.entity,
    entityId: a.entityId ?? undefined,
    before: a.before ?? undefined,
    after: a.after ?? undefined,
    ts: a.createdAt.getTime(),
  };
}

export interface AuditQuery {
  entity?: string;
  action?: string;
  actorId?: string;
  limit?: number;
  offset?: number;
}

export const auditService = {
  async list(q: AuditQuery) {
    const where = {
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
    };
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const offset = Math.max(q.offset ?? 0, 0);
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      prisma.auditLog.count({ where }),
    ]);
    return { items: items.map(mapAudit), total, limit, offset };
  },

  async getById(id: string) {
    const a = await prisma.auditLog.findUnique({ where: { id } });
    if (!a) throw NotFound('Audit entry not found');
    return mapAudit(a);
  },
};
