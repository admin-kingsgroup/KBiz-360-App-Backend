export type ChatKind = 'direct' | 'group';
export type MessageStatus = 'sent' | 'delivered' | 'read';

export interface Chat {
  id: string;
  kind: ChatKind;
  name: string;
  bizId?: string;
  branchCode?: string;
  unread?: number;
  ts?: number;
  preview?: string;
  online?: boolean;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  body: string;
  ts: number;
  status?: MessageStatus;
}
