import { AttendanceModel, type AttendanceDoc } from './attendance.model';

export const attendanceRepo = {
  findToday: (userId: string, dateKey: string) => AttendanceModel().findOne({ userId, dateKey }).lean<AttendanceDoc>(),

  // Idempotent upsert of the user's row for the day.
  upsert: (userId: string, dateKey: string, set: Partial<AttendanceDoc>) =>
    AttendanceModel().findOneAndUpdate(
      { userId, dateKey },
      { $set: set, $setOnInsert: { userId, dateKey } },
      { upsert: true, new: true },
    ).lean<AttendanceDoc>(),

  // Today's rows for a set of users (team view).
  forUsersOnDay: (dateKey: string, userIds: string[]) =>
    AttendanceModel().find({ dateKey, userId: { $in: userIds } }).lean<AttendanceDoc[]>(),
};
