import { collectAuthConfigProblems } from '../validateEnv';

// 40-char values → past the 32-char minimum, and not weak defaults.
const ACCESS = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const REFRESH = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';

const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  ({ JWT_ACCESS_SECRET: ACCESS, JWT_REFRESH_SECRET: REFRESH, ...over } as NodeJS.ProcessEnv);

describe('collectAuthConfigProblems', () => {
  it('accepts a valid strong configuration (no problems)', () => {
    expect(collectAuthConfigProblems(env({}))).toEqual([]);
  });

  it('flags a missing JWT_ACCESS_SECRET', () => {
    const p = collectAuthConfigProblems(env({ JWT_ACCESS_SECRET: undefined }));
    expect(p.some((m) => m.includes('JWT_ACCESS_SECRET') && m.includes('missing or empty'))).toBe(true);
  });

  it('flags an empty secret (the .env.production.example trap)', () => {
    const p = collectAuthConfigProblems(env({ JWT_REFRESH_SECRET: '' }));
    expect(p.some((m) => m.includes('JWT_REFRESH_SECRET') && m.includes('missing or empty'))).toBe(true);
  });

  it('flags a too-short secret', () => {
    const p = collectAuthConfigProblems(env({ JWT_ACCESS_SECRET: 'short-secret' }));
    expect(p.some((m) => m.includes('too short'))).toBe(true);
  });

  it('flags the known weak defaults', () => {
    const p = collectAuthConfigProblems({
      JWT_ACCESS_SECRET: 'change-me-access',
      JWT_REFRESH_SECRET: 'change-me-refresh',
    } as NodeJS.ProcessEnv);
    expect(p.some((m) => m.includes('placeholder/default'))).toBe(true);
  });

  it('flags identical access and refresh secrets', () => {
    const p = collectAuthConfigProblems(env({ JWT_REFRESH_SECRET: ACCESS }));
    expect(p.some((m) => m.includes('must be different'))).toBe(true);
  });

  it('rejects a weak EMAIL_TOKEN_KEY when explicitly set', () => {
    const p = collectAuthConfigProblems(env({ EMAIL_TOKEN_KEY: 'dev-email-token-key' }));
    expect(p.some((m) => m.includes('EMAIL_TOKEN_KEY'))).toBe(true);
  });

  it('allows EMAIL_TOKEN_KEY to be unset (it falls back to the validated JWT secret)', () => {
    expect(collectAuthConfigProblems(env({ EMAIL_TOKEN_KEY: undefined }))).toEqual([]);
  });

  it('accumulates every problem rather than stopping at the first', () => {
    const p = collectAuthConfigProblems({ JWT_ACCESS_SECRET: '', JWT_REFRESH_SECRET: '' } as NodeJS.ProcessEnv);
    expect(p.length).toBeGreaterThanOrEqual(2);
  });
});
