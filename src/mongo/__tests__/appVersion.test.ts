import { appVersionPolicy } from '../appVersion.router';

// Pure unit tests — no DB.

const cfg = {
  android: { minVersion: '1.2.0', storeUrl: 'https://play.google.com/store/apps/details?id=com.kingsgroup.kbiz360' },
  ios: { minVersion: undefined, storeUrl: undefined },
  notes: ['Faster chats', 'New HR menu'],
};

describe('appVersionPolicy', () => {
  it('returns the Android minimum, store link and release notes', () => {
    expect(appVersionPolicy('android', cfg)).toEqual({
      platform: 'android',
      minVersion: '1.2.0',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.kingsgroup.kbiz360',
      notes: ['Faster chats', 'New HR menu'],
    });
  });

  it('blocks no one on a platform with no minimum set', () => {
    expect(appVersionPolicy('ios', cfg)).toMatchObject({ platform: 'ios', minVersion: null, storeUrl: null });
  });

  it('treats a missing or unknown platform as Android', () => {
    expect(appVersionPolicy(undefined, cfg).platform).toBe('android');
    expect(appVersionPolicy('web', cfg).platform).toBe('android');
  });
});
