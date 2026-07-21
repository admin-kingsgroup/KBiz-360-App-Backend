import { connectMongo, disconnectMongo, appDb } from '../../connection';
import { alertService } from '../alert.service';

// Day-close idempotency: recordDayClose tags the event with reportKey=<day>; hasDayCloseReport
// finds it so the 10pm sweep never double-posts for the same (channel, day). Uses a SYNTHETIC
// channel id — sendChannelAlert no-ops for unknown channels, so no real push fires. Self-skips
// without Mongo; cleans up.
let ready = false;
const CH = `test-dayclose-${Date.now().toString(36)}`;
const DAY = '2020-01-02';

beforeAll(async () => {
  try { await connectMongo(); ready = true; } catch { ready = false; }
}, 40000);

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (ready) await (appDb().collection('alert_events') as any).deleteMany({ channelId: CH });
  await disconnectMongo();
}, 20000);

describe('attendance day-close idempotency', () => {
  it('no report exists before it is recorded', async () => {
    if (!ready) return;
    expect(await alertService.hasDayCloseReport(CH, DAY)).toBe(false);
  });

  it('recordDayClose makes hasDayCloseReport true for that (channel, day)', async () => {
    if (!ready) return;
    await alertService.recordDayClose(CH, DAY, { title: 'Day close · TEST · 3/5 present', body: 'Absent: A, B', context: 'TK TEST · Attendance' });
    expect(await alertService.hasDayCloseReport(CH, DAY)).toBe(true);
    // A different day on the same channel is independent.
    expect(await alertService.hasDayCloseReport(CH, '2020-01-03')).toBe(false);
  });
});
