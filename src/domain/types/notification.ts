export interface AppNotification {
  id: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  ts: number;
  read: boolean;
}
