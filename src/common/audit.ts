import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

// Append-only audit writer. Every mutation (Users, Reminders, Attendance, Roles, Auth…) records one.
export interface AuditInput {
  actorId?: string | null;
  action: string; // CREATE | UPDATE | DELETE | APPROVE | LOGIN | LOGOUT | REFRESH ...
  entity: string; // User | Reminder | AttendanceRecord | Role | Auth ...
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
