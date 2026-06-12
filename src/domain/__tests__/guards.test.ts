import { resolveGate, allPermsGranted } from '../navigation/guards';

describe('navigation gate (pure)', () => {
  it('signed out → login', () => {
    expect(resolveGate({ isAuthenticated: false, allPermsGranted: true })).toBe('login');
  });
  it('signed in, perms ungranted → permissions', () => {
    expect(resolveGate({ isAuthenticated: true, allPermsGranted: false })).toBe('permissions');
  });
  it('signed in + perms granted → app', () => {
    expect(resolveGate({ isAuthenticated: true, allPermsGranted: true })).toBe('app');
  });
  it('allPermsGranted requires all three', () => {
    expect(allPermsGranted({ location: true, notifications: true, network: true })).toBe(true);
    expect(allPermsGranted({ location: true, notifications: false, network: true })).toBe(false);
  });
});
