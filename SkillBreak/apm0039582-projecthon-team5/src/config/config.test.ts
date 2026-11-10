import { databaseOptions, loadConfig } from './config';

const validEnv: NodeJS.ProcessEnv = {
  HOST: '127.0.0.1',
  PORT: '3000',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USER: 'escape',
  DB_PASSWORD: 'local-password',
  DB_NAME: 'escape_room',
  DB_SSL: 'false',
  JWT_ACCESS_SECRET: Buffer.alloc(32, 7).toString('base64'),
};

describe('loadConfig', () => {
  test('loads defaults and validates the signing secret', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3000);
    expect(config.jwt.ttlSeconds).toBe(900);
    expect(config.jwt.secret).toHaveLength(32);
  });

  test('parses TLS settings and keeps certificate verification enabled', () => {
    expect(databaseOptions({ ...validEnv, DB_SSL: 'true' }).ssl).toEqual({ rejectUnauthorized: true });
    expect(databaseOptions(validEnv)).toMatchObject({ schema: 'team5', installExtensions: false,
      migrationsTableName: 'users_migrations', extra: { options: '-c search_path=team5' } });
    expect(() => databaseOptions({ ...validEnv, JWT_ACCESS_SECRET: undefined })).not.toThrow();
  });

  test('loads gateway defaults without enabling cross-origin access', () => {
    expect(loadConfig(validEnv)).toMatchObject({ engineInternalUrl: 'http://127.0.0.1:3001',
      internalApiToken: '', corsOrigins: [], swaggerEnabled: true });
    expect(loadConfig({ ...validEnv, NODE_ENV: 'production' }).swaggerEnabled).toBe(false);
    expect(loadConfig({ ...validEnv, NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }).swaggerEnabled).toBe(true);
    expect(loadConfig({ ...validEnv, CORS_ORIGINS: 'http://localhost:5173, https://example.com',
      INTERNAL_API_TOKEN: Buffer.alloc(32, 1).toString('base64') }).corsOrigins)
      .toEqual(['http://localhost:5173', 'https://example.com']);
  });

  test.each([
    { INTERNAL_API_TOKEN: 'short' }, { INTERNAL_API_TOKEN: Buffer.alloc(16).toString('base64') },
    { ENGINE_INTERNAL_URL: 'ftp://localhost' }, { ENGINE_INTERNAL_URL: 'http://user:pass@localhost' },
    { ENGINE_INTERNAL_URL: 'http://localhost/path' }, { ENGINE_INTERNAL_URL: 'http://localhost?token=secret' },
    { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'https://example.com/path' }, { SWAGGER_ENABLED: 'yes' },
  ])('rejects unsafe gateway configuration %#', extra => {
    expect(() => loadConfig({ ...validEnv, ...extra })).toThrow();
  });

  test.each([
    ['missing signing key', { ...validEnv, JWT_ACCESS_SECRET: undefined }],
    ['short signing key', { ...validEnv, JWT_ACCESS_SECRET: Buffer.alloc(16).toString('base64') }],
    ['invalid TLS value', { ...validEnv, DB_SSL: 'yes' }],
    ['invalid port', { ...validEnv, DB_PORT: '5432.5' }],
    ['missing database password', { ...validEnv, DB_PASSWORD: undefined }],
  ])('rejects %s', (_description, env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});