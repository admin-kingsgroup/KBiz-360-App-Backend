export type ReminderSection = 'today' | 'week' | string;
export type ReminderState = 'open' | 'approved' | 'review' | string;

export interface Reminder {
  id: string;
  title?: string;
  text?: string;
  section: ReminderSection;
  forId: string;
  forName: string;
  forInitials?: string;
  forColor?: string;
  byId: string;
  byName?: string;
  state?: ReminderState;
  date?: string;
}

export type ReminderGroupMode = 'person' | 'role';

export interface ReminderGroup {
  key: string;
  mode: ReminderGroupMode;
  items: Reminder[];
  // person mode
  name?: string;
  initials?: string;
  avColor?: string;
  sub?: string;
  // role mode
  label?: string;
  color?: string;
}
