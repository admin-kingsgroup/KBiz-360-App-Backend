import { connectMongo, disconnectMongo, appDb } from '../../connection';
import { crmRepo } from '../../crm.repo';
import { alertService } from '../alert.service';
import { USER_ALERTS_CHANNEL_ID } from '../alertChannels';

// DB-backed: personal "User Alerts" are addressed to a single user and only that user sees them.
// Self-skips (like the chat realtime suite) when the shared Mongo isn't reachable.
let ready = false;
let idA = '';
let idB = '';
const MARK = 'JEST-user-alert';

beforeAll(async () => {
  try {
    await connectMongo();
    const a = await crmRepo.findUserByEmail('afshin.dhanani@kingsgroupco.com'); // super admin
    const b = await crmRepo.findUserByEmail('pravesh@travkings.com'); // branch manager
    ready = Boolean(a && b);
    if (!ready) return;
    idA = String(a!._id);
    idB = String(b!._id);
  } catch {
    ready = false;
  }
}, 40000);

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (ready) await (appDb().collection('alert_events') as any).deleteMany({ channelId: USER_ALERTS_CHANNEL_ID, source: MARK });
  await disconnectMongo();
}, 20000);

describe('User Alerts — personal & recipient-isolated', () => {
  it('the subject user sees their own alert; another user never does', async () => {
    if (!ready) return;
    await alertService.recordUserAlert(idA, { source: MARK, title: 'You checked in', body: '09:15', context: 'Your attendance' });

    const mine = (await alertService.listFor(idA)).events.filter((e) => e.channelId === USER_ALERTS_CHANNEL_ID && e.source === MARK);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].title).toBe('You checked in');

    const others = (await alertService.listFor(idB)).events.filter((e) => e.channelId === USER_ALERTS_CHANNEL_ID && e.source === MARK);
    expect(others.length).toBe(0); // B (and even a super) never sees A's personal alert
  });

  it('markChannelRead on user_alerts only marks the caller’s own events', async () => {
    if (!ready) return;
    await alertService.recordUserAlert(idB, { source: MARK, title: 'You checked out', body: '18:30', context: 'Your attendance' });
    await alertService.markChannelRead(idA, USER_ALERTS_CHANNEL_ID); // A marks their channel read

    // B's freshly-created alert must still be unread (A's read didn't touch B's events).
    const forB = (await alertService.listFor(idB)).events.find((e) => e.channelId === USER_ALERTS_CHANNEL_ID && e.title === 'You checked out');
    expect(forB?.read).toBe(false);
  });
});
