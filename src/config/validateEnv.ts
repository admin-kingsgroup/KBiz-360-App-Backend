// Startup validation for authentication-related secrets. The server MUST NOT boot with a missing,
// empty, too-short, or well-known-placeholder JWT secret — a weak or empty HS256 secret makes every
// access/refresh token forgeable (full account takeover). `collectAuthConfigProblems` is pure (takes
// an env, returns a list of problems) so it can be unit-tested without exiting; `validateAuthConfig`
// prints the problems and terminates the process. Called first in the Mongo entrypoint's bootstrap().

const MIN_SECRET_LEN = 32;

// Known dev/example placeholders that must never reach a running server. Anything containing
// "change-me" is also rejected (covers the values historically shipped in .env.example).
const WEAK_SECRETS = new Set([
  'change-me-access',
  'change-me-refresh',
  'dev-access-secret',
  'dev-refresh-secret',
  'dev-email-token-key',
]);

function isWeak(value: string): boolean {
  return WEAK_SECRETS.has(value) || value.includes('change-me');
}

function checkJwtSecret(name: string, raw: string | undefined, problems: string[]): void {
  const value = (raw ?? '').trim();
  if (!value) {
    problems.push(`${name} is missing or empty — set a strong random value (e.g. \`openssl rand -hex 32\`).`);
    return;
  }
  if (value.length < MIN_SECRET_LEN) {
    problems.push(`${name} is too short (${value.length} chars) — use at least ${MIN_SECRET_LEN} characters.`);
  }
  if (isWeak(value)) {
    problems.push(`${name} is a known placeholder/default — replace it with a unique random secret.`);
  }
}

// Pure: returns human-readable problems (empty array = valid). No side effects — safe to unit-test.
export function collectAuthConfigProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  checkJwtSecret('JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET, problems);
  checkJwtSecret('JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET, problems);

  const access = (env.JWT_ACCESS_SECRET ?? '').trim();
  const refresh = (env.JWT_REFRESH_SECRET ?? '').trim();
  if (access && refresh && access === refresh) {
    problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
  }

  // EMAIL_TOKEN_KEY encrypts stored Microsoft refresh tokens. When unset it falls back to the
  // (already-validated) JWT_ACCESS_SECRET for backward compatibility, so only reject an explicitly
  // provided value that is a known weak default — never enforce a new key on existing deployments.
  const emailKey = (env.EMAIL_TOKEN_KEY ?? '').trim();
  if (emailKey && isWeak(emailKey)) {
    problems.push('EMAIL_TOKEN_KEY is a known placeholder/default — replace it with a unique random value.');
  }

  return problems;
}

// Enforces the checks at startup. On any problem, prints a clear itemized block and exits — the
// server never runs with an insecure auth configuration. Silent no-op when configuration is valid.
export function validateAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = collectAuthConfigProblems(env);
  if (problems.length === 0) return;
  // eslint-disable-next-line no-console
  console.error(
    [
      '',
      '✖ Refusing to start: invalid authentication configuration.',
      ...problems.map((p) => `  • ${p}`),
      '',
      'Fix the environment (.env / .env.production) and restart.',
      '',
    ].join('\n'),
  );
  // eslint-disable-next-line no-process-exit
  process.exit(1);
}
