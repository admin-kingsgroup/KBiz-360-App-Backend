// Pure notification → route mapping. No native imports, so it is unit-testable.
export type NotifType = 'reminder' | 'chat' | 'alert' | 'attendance';
export interface NotifData { type?: NotifType; id?: string }

export function routeForData(data: NotifData): { pathname: string; params?: Record<string, string> } {
  switch (data.type) {
    case 'chat': return { pathname: '/chat/[id]', params: { id: data.id ?? '' } };
    case 'alert': return { pathname: '/alert/[id]', params: { id: data.id ?? '' } };
    case 'attendance': return { pathname: '/attendance' };
    case 'reminder': return { pathname: '/(tabs)/reminders' };
    default: return { pathname: '/(tabs)' };
  }
}
