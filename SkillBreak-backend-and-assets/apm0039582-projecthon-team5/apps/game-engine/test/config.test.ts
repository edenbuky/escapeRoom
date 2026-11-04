import { loadConfig, databaseOptions } from '../src/config/config';

test('projection JWT is optional but partial or invalid settings fail', () => {
  expect(loadConfig(environment)).toMatchObject({ corsOrigins: [] });
  expect(loadConfig(environment).jwt).toBeUndefined();
  const JWT_ACCESS_SECRET = Buffer.alloc(32, 9).toString('base64');
  expect(loadConfig({ ...environment, JWT_ACCESS_SECRET }).jwt).toMatchObject({
    issuer: 'escape-room-api', audience: 'escape-room-client', ttlSeconds: 900,
  });
  for (const extra of [{ JWT_ISSUER: 'test' }, { JWT_ACCESS_SECRET: 'short' },
    { JWT_ACCESS_SECRET, JWT_ACCESS_TTL: '0' }, { JWT_ACCESS_SECRET, JWT_AUDIENCE: '' },
    { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'https://example.com/path' }]) {
    expect(() => loadConfig({ ...environment, ...extra })).toThrow();
  }
  expect(loadConfig({ ...environment, CORS_ORIGINS: 'http://localhost:5173' }).corsOrigins).toEqual(['http://localhost:5173']);
});

export const environment = {
  DATABASE_URL: 'postgresql://engine:local-test-password@127.0.0.1:5433/engine_db',
  REDIS_URL: 'redis://127.0.0.1:6379',
};
test('engine configuration is independent of gateway and cloud credentials', () => {
  const config = loadConfig(environment);
  expect(config.port).toBe(3001);
  expect(config.runtimeClass).toBe('runc');
  expect(config.databaseUrl).toBe(environment.DATABASE_URL);
  expect(databaseOptions(config).synchronize).toBe(false);
  expect(() => loadConfig({ DB_HOST: 'gateway', REDIS_URL: environment.REDIS_URL })).toThrow('DATABASE_URL');
});
test.each(['DATABASE_URL', 'REDIS_URL'])('requires %s and sanitizes invalid values', key => {
  expect(() => loadConfig({ ...environment, [key]: '' })).toThrow(key);
  expect(() => loadConfig({ ...environment, [key]: 'secret-invalid-value' })).not.toThrow('secret-invalid-value');
  expect(() => loadConfig({ ...environment, [key]: 'secret-invalid-value' })).toThrow(key);
});
test.each(['0', '-1', '65536', '1.5', 'not-a-port'])('rejects invalid port %s', PORT => {
  expect(() => loadConfig({ ...environment, PORT })).toThrow('PORT');
});
test('container DB components override host URL and encode credentials once', () => {
  const password = 'a@:/%#?b';
  const config = loadConfig({ ...environment, ENGINE_DB_HOST: 'engine-db', ENGINE_DB_USER: 'engine@user',
    ENGINE_DB_PASSWORD: password, ENGINE_DB_NAME: 'engine_db' });
  const url = new URL(config.databaseUrl);
  expect(url.hostname).toBe('engine-db');
  expect(decodeURIComponent(url.username)).toBe('engine@user');
  expect(decodeURIComponent(url.password)).toBe(password);
  expect(loadConfig({ ...environment, DATABASE_URL: config.databaseUrl }).databaseUrl).toBe(config.databaseUrl);
});
test('rejects secret placeholders and invalid future runtime names', () => {
  expect(() => loadConfig({ ...environment, DATABASE_URL: 'postgres://engine:REPLACE_ME@localhost/engine_db' })).toThrow('DATABASE_URL');
  expect(() => loadConfig({ ...environment, SANDBOX_RUNTIME_CLASS: 'BAD RUNTIME' })).toThrow('SANDBOX_RUNTIME_CLASS');
  expect(loadConfig({ ...environment, SANDBOX_RUNTIME_CLASS: 'kata' }).runtimeClass).toBe('kata');
});

test('internal catalog token is optional for foundation startup but validated when configured', () => {
  expect(loadConfig(environment).internalApiToken).toBeUndefined();
  const token = Buffer.alloc(32, 7).toString('base64');
  expect(loadConfig({ ...environment, INTERNAL_API_TOKEN: token }).internalApiToken).toBe(token);
  for (const invalid of ['REPLACE_ME', 'short', 'not-base64-token!', Buffer.alloc(31).toString('base64')]) {
    expect(() => loadConfig({ ...environment, INTERNAL_API_TOKEN: invalid })).toThrow('INTERNAL_API_TOKEN');
  }
});

test('sandbox is opt-in and disabled startup does not need Kubernetes credentials', () => {
  const config = loadConfig(environment);
  expect(config.sandbox.enabled).toBe(false);
  expect(config.sandbox.workerConcurrency).toBe(2);
  expect(config.sandbox.imageAllowlist).toEqual([]);
  expect(config.sandbox.kubeContext).toBeUndefined();
  expect(databaseOptions(config)).toMatchObject({ extra: { max: 10, query_timeout: 2000, statement_timeout: 2000 } });
});

test('enabled local sandbox requires exact explicit context and pinned-image repository allowlist', () => {
  const local = { ...environment, SANDBOX_ENABLED: 'true', SANDBOX_KUBE_CONTEXT: 'kind-skillbreak-local',
    SANDBOX_IMAGE_ALLOWLIST: 'localhost:5001/room1-sql' };
  expect(loadConfig(local).sandbox).toMatchObject({ enabled: true, kubeContext: 'kind-skillbreak-local',
    imageAllowlist: ['localhost:5001/room1-sql'], workerConcurrency: 2 });
  expect(() => loadConfig({ ...local, SANDBOX_KUBE_CONTEXT: '' })).toThrow('SANDBOX_KUBE_CONTEXT');
  expect(() => loadConfig({ ...local, SANDBOX_KUBE_CONTEXT: 'corporate' })).toThrow('SANDBOX_KUBE_CONTEXT');
  expect(() => loadConfig({ ...local, SANDBOX_IMAGE_ALLOWLIST: '' })).toThrow('SANDBOX_IMAGE_ALLOWLIST');
  for (const invalid of ['*', 'https://registry/sql', 'registry/sql:dev', 'registry/sql@sha256:a']) {
    expect(() => loadConfig({ ...local, SANDBOX_IMAGE_ALLOWLIST: invalid })).toThrow('SANDBOX_IMAGE_ALLOWLIST');
  }
});

test('production uses the explicitly selected runtime with no fallback or local-context requirement', () => {
  const config = loadConfig({ ...environment, NODE_ENV: 'production', SANDBOX_ENABLED: 'true',
    SANDBOX_IMAGE_ALLOWLIST: 'registry.example/team5/sql' });
  expect(config.runtimeClass).toBe('kata');
  expect(config.sandbox.kubeContext).toBeUndefined();
});

test.each(['1', 'yes', 'TRUE', ''])('rejects ambiguous sandbox enablement %s', SANDBOX_ENABLED => {
  expect(() => loadConfig({ ...environment, SANDBOX_ENABLED })).toThrow('SANDBOX_ENABLED');
});

test.each(['0', '-1', '5', '1.5', 'NaN'])('bounds worker connections %s', SANDBOX_WORKER_CONCURRENCY => {
  expect(() => loadConfig({ ...environment, SANDBOX_WORKER_CONCURRENCY })).toThrow('SANDBOX_WORKER_CONCURRENCY');
});
