import { appDb } from '../connection';

// Per-user WORKING BRANCH: the branch a person physically reports at and marks attendance against.
// Set by a super-admin from the attendance screen. Stored in kb360_app (CRM is READ-ONLY). Absence of
// a record = no override → the user falls back to the first branch in their CRM branch_ids (access).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('user_work_branches') as any;

export const userWorkBranches = {
  // Set a user's working branch, or clear it when branchId is null/blank.
  async setBranch(userId: string, branchId: string | null, by: string): Promise<void> {
    if (!branchId) {
      await col().deleteOne({ userId });
      return;
    }
    await col().updateOne(
      { userId },
      { $set: { userId, branchId, updatedBy: by, updatedAt: new Date() } },
      { upsert: true },
    );
  },

  async branchIdFor(userId: string): Promise<string | null> {
    const doc = await col().findOne({ userId });
    return doc?.branchId ? String(doc.branchId) : null;
  },

  // Map of userId → branchId for the given users (only explicitly assigned users appear).
  async mapFor(userIds: string[]): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    if (!userIds.length) return map;
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    for (const d of docs) if (d.branchId) map[String(d.userId)] = String(d.branchId);
    return map;
  },
};
