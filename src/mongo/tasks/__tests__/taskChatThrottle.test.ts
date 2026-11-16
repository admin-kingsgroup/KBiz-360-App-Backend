// No DB. Task chats push at most once per chat per person every 5 minutes; an @mention always gets through.
import { TASK_CHAT_PUSH_GAP_MS, taskChatPushAllowed } from '../../chat/chat.service';

describe('task chat push grouping', () => {
  const t0 = 1_800_000_000_000;
  it('one push per 5 minutes per person per chat', () => {
    expect(taskChatPushAllowed('chatA', 'satish', false, t0)).toBe(true);
    expect(taskChatPushAllowed('chatA', 'satish', false, t0 + 60_000)).toBe(false);
    expect(taskChatPushAllowed('chatA', 'afshin', false, t0 + 60_000)).toBe(true); // another person
    expect(taskChatPushAllowed('chatB', 'satish', false, t0 + 60_000)).toBe(true); // another chat
    expect(taskChatPushAllowed('chatA', 'satish', false, t0 + TASK_CHAT_PUSH_GAP_MS)).toBe(true);
  });
  it('a mention is never held back', () => {
    expect(taskChatPushAllowed('chatC', 'faiz', false, t0)).toBe(true);
    expect(taskChatPushAllowed('chatC', 'faiz', true, t0 + 1000)).toBe(true);
  });
});
