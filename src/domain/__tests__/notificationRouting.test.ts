import { routeForData } from '../services/notifications/routes';

describe('Notifications — tap routes to the right screen', () => {
  it('chat → chat/[id] with id param', () => {
    expect(routeForData({ type: 'chat', id: 'u3' })).toEqual({ pathname: '/chat/[id]', params: { id: 'u3' } });
  });
  it('alert → alert/[id]', () => {
    expect(routeForData({ type: 'alert', id: 'tk_crm' })).toEqual({ pathname: '/alert/[id]', params: { id: 'tk_crm' } });
  });
  it('attendance → attendance', () => {
    expect(routeForData({ type: 'attendance' })).toEqual({ pathname: '/attendance' });
  });
  it('reminder → reminders tab', () => {
    expect(routeForData({ type: 'reminder', id: 'r1' })).toEqual({ pathname: '/(tabs)/reminders' });
  });
  it('unknown/empty → home', () => {
    expect(routeForData({})).toEqual({ pathname: '/(tabs)' });
  });
});
