// Reminder filter tabs. Index 3 ('All') triggers name-wise grouping + canSee filtering.
export const FILTERS = ['For me', 'I set', 'Review', 'All'] as const;
export type ReminderFilter = typeof FILTERS[number];
