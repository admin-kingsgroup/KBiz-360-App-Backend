/* eslint-disable no-console */
import * as bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

// Seed = the frontend mock data, reproduced EXACTLY. We import the verbatim domain copies so the
// DB is byte-faithful to src/data/*. Identity links follow the approved rule: link ReminderViewer
// → User only where role + name AGREE; leave divergent/orphan records unlinked (see foundation §6).
import { businesses, branches, businessDepts } from '../src/domain/data/businesses';
import { adminUsers, PERSON_META } from '../src/domain/data/users';
import { seedReminders, reminderPeople } from '../src/domain/data/reminders';
import { directChats } from '../src/domain/data/chats';
import { pulseChannels, pulseEvents } from '../src/domain/data/pulse';
import { teamAttendance } from '../src/domain/data/team';
import { ROLE_DEFS, RANK, ROLE_OPTIONS } from '../src/domain/constants/roles';

const prisma = new PrismaClient();

const SEED_DATE = new Date('2026-06-10T00:00:00.000Z');

// Dev-only password for ALL seeded users (the frontend login is simulated; real auth lands in Phase 2).
// Override per-user / disable in production seeds.
const DEV_PASSWORD = 'kbiz360';
const DEV_PASSWORD_HASH = bcrypt.hashSync(DEV_PASSWORD, 10);

// PEOPLE_BIZ is private in data/reminders.ts — reproduced verbatim here.
const PEOPLE_BIZ: Record<string, string | null> = {
  a: null, fa: 'tk', p: 'tk', f: 'tk', m: 'tk', r: 'tk', sn: 'tk', ko: 'tk', an: 'tk',
};

// Confident ReminderViewer → User links (role + name agree). Others stay null by design:
//  f  → a4 is HOD "Faiz Patel" but viewer f is BRANCH_MANAGER "Faiz Khan"  (role + surname diverge)
//  m,r,sn,ko,an → no adminUsers counterpart (orphans in the access space)
const VIEWER_USER_LINK: Record<string, string | null> = {
  a: 'a1', fa: 'a2', p: 'a3', f: null, m: null, r: null, sn: null, ko: null, an: null,
};

function parseClock(label: string | null, base: Date): Date | null {
  if (!label) return null;
  const m = label.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const d = new Date(base);
  d.setUTCHours(h, min, 0, 0);
  return d;
}

async function clear(): Promise<void> {
  // Children first (FK-safe).
  await prisma.auditLog.deleteMany();
  await prisma.upload.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.device.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.message.deleteMany();
  await prisma.chatParticipant.deleteMany();
  await prisma.chat.deleteMany();
  await prisma.attendanceRecord.deleteMany();
  await prisma.reminder.deleteMany();
  await prisma.reminderViewer.deleteMany();
  await prisma.alertEvent.deleteMany();
  await prisma.alertChannel.deleteMany();
  await prisma.group.deleteMany();
  await prisma.department.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.user.deleteMany();
  await prisma.business.deleteMany();
  await prisma.role.deleteMany();
}

async function main(): Promise<void> {
  console.log('Seeding KBiz360 backend (faithful reproduction of src/data/*)…');
  await clear();

  // 1) Roles — from ROLE_DEFS + RANK.
  await prisma.role.createMany({
    data: ROLE_OPTIONS.map((key) => ({
      key,
      label: ROLE_DEFS[key].label,
      badge: ROLE_DEFS[key].badge,
      color: ROLE_DEFS[key].color,
      scope: ROLE_DEFS[key].scope,
      sees: ROLE_DEFS[key].sees,
      rank: RANK[key],
      perms: ROLE_DEFS[key].perms,
    })),
  });

  // 2) Businesses.
  await prisma.business.createMany({
    data: businesses.map((b) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      industry: b.industry ?? null,
      shortInd: b.shortInd ?? null,
      color: b.color,
      tint: b.tint ?? null,
      branchCount: b.branches,
      userCount: b.users ?? null,
      status: b.status,
      unread: b.unread ?? null,
      active: b.active ?? null,
    })),
  });

  // 3) Branches (only tk has them).
  await prisma.branch.createMany({
    data: branches.map((br) => ({
      id: br.id,
      code: br.code,
      bizId: 'tk',
      city: br.city,
      country: br.country,
      flag: br.flag,
      tz: br.tz,
      lat: br.lat,
      lng: br.lng,
      radius: br.radius,
      wifi: br.wifi,
      color: br.color,
    })),
  });

  // 4) Groups (per branch).
  await prisma.group.createMany({
    data: branches.flatMap((br) =>
      br.groups.map((g) => ({ id: g.id, branchId: br.id, name: g.name, icon: g.icon, color: g.color })),
    ),
  });

  // 5) Departments (per business).
  await prisma.department.createMany({
    data: Object.entries(businessDepts).flatMap(([bizId, depts]) =>
      depts.map((d) => ({ id: d.id, bizId, name: d.name, icon: d.icon, color: d.color })),
    ),
  });

  // 6) Alert channels + 7) events.
  await prisma.alertChannel.createMany({
    data: pulseChannels.map((c) => ({
      id: c.id,
      bizId: c.bizId,
      module: c.module,
      name: c.name,
      icon: c.icon,
      color: c.color,
      tint: c.tint,
      description: c.description,
      memberKeys: c.members,
    })),
  });
  await prisma.alertEvent.createMany({
    data: pulseEvents.map((e) => ({
      id: e.id,
      channelId: e.channelId,
      source: e.source,
      title: e.title,
      body: e.body,
      context: e.context,
      occurredAt: new Date(e.time),
      read: e.read,
      actions: e.actions ?? undefined,
    })),
  });

  // 8) Users (access space) — id preserved from adminUsers ('a1'..) for stable references.
  await prisma.user.createMany({
    data: adminUsers.map((u) => ({
      id: u.id,
      legacyAdminId: u.id,
      name: u.name,
      email: u.email ?? null,
      initials: u.initials,
      color: u.color,
      role: u.role,
      bizId: u.bizId,
      branches: u.branches,
      accessGroups: u.accessGroups,
      accessDepts: u.accessDepts,
      accessAlerts: u.accessAlerts,
      scopeLine: u.scopeLine ?? null,
      loginLabel: u.login ?? null,
      attendanceEnabled: u.attendance ?? null,
      passwordHash: DEV_PASSWORD_HASH,
    })),
  });

  // 9) ReminderViewers (canSee space) — role/branches/dept STORED (not derived); linked only where confident.
  const peopleById = new Map(reminderPeople.map((p) => [p.id, p]));
  const linkSummary: string[] = [];
  await prisma.reminderViewer.createMany({
    data: Object.entries(PERSON_META).map(([id, meta]) => {
      const person = peopleById.get(id);
      const userId = VIEWER_USER_LINK[id] ?? null;
      linkSummary.push(`${id}(${meta.role}) → ${userId ? `User ${userId}` : 'UNLINKED'}`);
      return {
        id,
        role: meta.role,
        branches: meta.branches,
        dept: meta.dept,
        name: person?.name ?? null,
        initials: person?.initials ?? null,
        color: person?.color ?? null,
        bizId: PEOPLE_BIZ[id] ?? null,
        userId,
      };
    }),
  });

  // 10) Reminders (reference ReminderViewer ids).
  await prisma.reminder.createMany({
    data: seedReminders.map((r) => ({
      id: r.id,
      title: r.title ?? null,
      text: r.text ?? null,
      section: r.section,
      forId: r.forId,
      forName: r.forName,
      forInitials: r.forInitials ?? null,
      forColor: r.forColor ?? null,
      byId: r.byId,
      byName: r.byName ?? null,
      byInitials: r.byInitials ?? null,
      byColor: r.byColor ?? null,
      state: r.state,
      whenLabel: r.when ?? null,
      overdue: r.overdue ?? null,
      dueDate: r.date ?? null,
    })),
  });

  // 11) Chats (DM space) + per-viewer unread participant (viewer = Afshin / User a1).
  await prisma.chat.createMany({
    data: directChats.map((c) => ({
      id: c.id,
      kind: 'direct' as const,
      name: c.name,
      preview: c.preview,
      online: c.online ?? null,
      lastMessageAt: new Date(c.ts),
    })),
  });
  await prisma.chatParticipant.createMany({
    data: directChats.map((c) => ({
      chatId: c.id,
      userId: 'a1', // signed-in viewer carries the DM unread (chatStore is single-viewer today)
      dmKey: c.id,
      displayName: c.name,
      unread: c.unread ?? 0,
    })),
  });

  // 12) Attendance (team dashboard snapshot). Link to User by exact name where possible (Farhan Aga → a2).
  const userByName = new Map(adminUsers.map((u) => [u.name, u.id]));
  await prisma.attendanceRecord.createMany({
    data: teamAttendance.map((t) => ({
      userId: userByName.get(t.name) ?? null, // link where the person is a canonical User (Farhan → a2)
      memberName: t.name, // dashboard snapshot always carries its own display fields
      memberInitials: t.initials,
      memberColor: t.color,
      branchLabel: t.branch,
      date: SEED_DATE,
      checkInAt: parseClock(t.in, SEED_DATE),
      checkOutAt: parseClock(t.out, SEED_DATE),
      method: t.via,
      present: t.in != null,
    })),
  });

  // 13) Audit trail marker for the seed itself.
  await prisma.auditLog.create({
    data: { actorId: null, action: 'SEED', entity: 'System', entityId: null, after: { seededAt: SEED_DATE.toISOString() } },
  });

  // ── Summary ──
  const counts = {
    roles: await prisma.role.count(),
    businesses: await prisma.business.count(),
    branches: await prisma.branch.count(),
    groups: await prisma.group.count(),
    departments: await prisma.department.count(),
    alertChannels: await prisma.alertChannel.count(),
    alertEvents: await prisma.alertEvent.count(),
    users: await prisma.user.count(),
    reminderViewers: await prisma.reminderViewer.count(),
    reminders: await prisma.reminder.count(),
    chats: await prisma.chat.count(),
    chatParticipants: await prisma.chatParticipant.count(),
    attendance: await prisma.attendanceRecord.count(),
  };
  console.log('Seed counts:', counts);
  console.log('Identity links (ReminderViewer → User):');
  linkSummary.forEach((l) => console.log('  ' + l));
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log('Seed complete.');
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
