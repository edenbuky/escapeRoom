require('reflect-metadata');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');

const databaseTests = process.env.RUN_GATEWAY_DB_TESTS === '1' ? describe : describe.skip;
databaseTests('gateway integration (disposable PostgreSQL and real engine owner HTTP)', () => {
  let container;
  let database;
  let engineDatabase;
  let gateway;
  let engine;
  let base;
  let engineBase;
  let config;
  let createGatewayApp;
  let owner;
  let other;
  let admin;
  let sessionId;
  const password = 'A long integration password 563!';
  const publish = jest.fn();

  async function request(path, body, access, method = 'POST', url = base) {
    return fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json',
      ...(access ? { Authorization: `Bearer ${access}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function login(username) {
    const response = await request('/auth/login', { username, password });
    expect(response.status).toBe(200);
    return response.json();
  }
  async function signup(username) {
    const response = await request('/auth/signup', { username, password, email: `${username}@example.com` });
    expect(response.status).toBe(201);
    return login(username);
  }
  async function withGateway(overrides, operation) {
    const app = await createGatewayApp({ config, database, producer: { publish }, ...overrides });
    try { await app.listen(0, '127.0.0.1'); await operation(app, await app.getUrl()); }
    finally { await app.close(); }
  }

  beforeAll(async () => {
    ({ createGatewayApp } = require('../runtime/main'));
    const { loadConfig, gatewayDatabaseOptions } = require('../runtime/config/config');
    const { User } = require('../runtime/database/entities/user.entity');
    const { RefreshFamily } = require('../runtime/database/entities/refresh-family.entity');
    const { RefreshToken } = require('../runtime/database/entities/refresh-token.entity');
    const { InitialSchema1740000000000 } = require('../runtime/database/migrations/1740000000000-InitialSchema');
    const { createEngineApp } = require('@team5/game-engine/bootstrap');
    const databasePassword = randomBytes(32).toString('hex');
    const internalToken = randomBytes(32).toString('base64');
    container = execFileSync('docker', ['run', '--detach', '--rm', '--label', 'team5.test=gateway-1.6',
      '--env', `POSTGRES_PASSWORD=${databasePassword}`, '--env', 'POSTGRES_DB=gateway_test',
      '--publish', '127.0.0.1::5432', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', 'postgres:16-alpine'],
    { encoding: 'utf8', timeout: 60000 }).trim();
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop());
    if (!Number.isInteger(port) || port < 1) throw new Error('Temporary database port unavailable');
    config = loadConfig({ DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'postgres', DB_PASSWORD: databasePassword,
      DB_NAME: 'gateway_test', JWT_ACCESS_SECRET: randomBytes(32).toString('base64'), INTERNAL_API_TOKEN: internalToken,
      CORS_ORIGINS: 'http://localhost:5173', SWAGGER_ENABLED: 'true' });
    database = new DataSource({ ...gatewayDatabaseOptions(config), entities: [User, RefreshFamily, RefreshToken],
      migrations: [InitialSchema1740000000000] });
    const deadline = Date.now() + 30000;
    while (!database.isInitialized) {
      try { await database.initialize(); }
      catch { if (Date.now() >= deadline) throw new Error('Temporary PostgreSQL not ready');
        await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    await database.runMigrations();
    await database.query('CREATE DATABASE engine_test');
    engine = await createEngineApp({ config: { host: '127.0.0.1', port: 3001,
      databaseUrl: `postgres://postgres:${databasePassword}@127.0.0.1:${port}/engine_test`,
      runtimeClass: 'runc', internalApiToken: internalToken, corsOrigins: [],
      sandbox: { enabled: false, imageAllowlist: [], workerConcurrency: 2 } } });
    engineDatabase = engine.get(DataSource);
    await engineDatabase.runMigrations();
    const { CatalogRepository } = require('../../apps/game-engine/dist/modules/script-catalog/catalog.repository');
    const catalog = new CatalogRepository(engineDatabase);
    await catalog.seed();
    await catalog.publishGameplay();
    await engine.listen(0, '127.0.0.1');
    engineBase = await engine.getUrl();
    config.engineInternalUrl = engineBase;
    gateway = await createGatewayApp({ config, database, producer: { publish } });
    await gateway.listen(0, '127.0.0.1');
    base = await gateway.getUrl();
    owner = await signup('owner');
    other = await signup('other');
    admin = await signup('admin');
    await database.query("UPDATE users SET role='admin' WHERE id=$1", [admin.user.id]);
    admin = await login('admin');
    sessionId = (await (await request('/sessions', { scriptSlug: 'escape-room', requestId: randomUUID() }, owner.accessToken)).json()).sessionId;
  }, 90000);

  afterAll(async () => {
    try { await gateway?.close(); }
    finally {
      try { await engine?.close(); }
      finally {
        try { if (database?.isInitialized) await database.destroy(); }
        finally { if (container) execFileSync('docker', ['stop', '--time', '1', container], { stdio: 'ignore', timeout: 30000 }); }
      }
    }
  }, 40000);
  beforeEach(() => publish.mockReset().mockResolvedValue(undefined));
  afterEach(() => jest.restoreAllMocks());

  test('real login authenticates profile and exposes no secret fields', async () => {
    expect(owner.tokenType).toBe('Bearer');
    expect((await request('/auth/login', { username: 'owner', password: 'wrong password but long enough' })).status).toBe(401);
    const response = await request('/me', undefined, owner.accessToken, 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: owner.user.id, role: 'player' });
    expect(owner.user).not.toHaveProperty('passwordHash');
  });

  test('retries preserve canonical identities and authenticated actor through real owner HTTP', async () => {
    const start = { scriptSlug: 'escape-room', requestId: randomUUID() };
    const input = { commandId: randomUUID(), input: { kind: 'command', command: 'SELECT 1' } };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await request('/sessions', start, owner.accessToken)).status).toBe(202);
      expect((await request(`/sessions/${sessionId}/puzzles/idan-db/inputs`, input, owner.accessToken)).status).toBe(202);
      expect((await request(`/sessions/${sessionId}/abandon`, undefined, owner.accessToken)).status).toBe(202);
    }
    expect(publish.mock.calls.slice(0, 2)).toEqual(publish.mock.calls.slice(2));
    expect(await (await request('/sessions/resume', undefined, owner.accessToken, 'GET')).json()).toEqual({ sessionId });
    for (const [stream, command] of publish.mock.calls) {
      expect(stream).toBe('player-commands');
      expect(command.payload.userId).toBe(owner.user.id);
      expect(Object.keys(command).sort()).toEqual(['messageId', 'payload', 'sessionId', 'type']);
    }
    const response = await fetch(`${engineBase}/internal/sessions/${sessionId}/owner`, {
      headers: { 'x-internal-token': config.internalApiToken } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ownerId: owner.user.id });
  });

  test.each(['player', 'admin'])('denies non-owner %s on both owner-protected routes', async role => {
    const access = role === 'admin' ? admin.accessToken : other.accessToken;
    expect((await request(`/sessions/${sessionId}/puzzles/idan-db/inputs`, {
      commandId: randomUUID(), input: { kind: 'answer', answer: 'hash' } }, access)).status).toBe(403);
    expect((await request(`/sessions/${sessionId}/abandon`, undefined, access)).status).toBe(403);
    expect((await request(`/sessions/${sessionId}/rooms/room-1/open-door`, { commandId: randomUUID() }, access)).status).toBe(403);
    expect(publish).not.toHaveBeenCalled();
  });

  test('returns 404 for a missing real engine session', async () => {
    expect((await request(`/sessions/${randomUUID()}/abandon`, undefined, owner.accessToken)).status).toBe(404);
    expect(publish).not.toHaveBeenCalled();
  });

  test.each(['missing token', 'wrong token', 'unreachable engine'])('fails closed with %s', async mode => {
    const overrides = mode === 'missing token' ? { internalApiToken: '' } : mode === 'wrong token'
      ? { internalApiToken: randomBytes(32).toString('base64') } : { engineInternalUrl: 'http://127.0.0.1:1' };
    await withGateway({ config: { ...config, ...overrides } }, async (_app, url) => {
      const response = await request(`/sessions/${sessionId}/abandon`, undefined, owner.accessToken, 'POST', url);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(config.internalApiToken);
      expect(publish).not.toHaveBeenCalled();
    });
  });

  test('validates canonical DTOs and identifiers before publishing', async () => {
    for (const input of [{ query: 'SELECT 1' }, { kind: 'credentials', username: 'dana' },
      { kind: 'answer', answer: 'x', ownerId: owner.user.id }, { kind: 'command', command: 'x'.repeat(8200) }]) {
      expect((await request(`/sessions/${sessionId}/puzzles/idan-db/inputs`, { commandId: randomUUID(), input }, owner.accessToken)).status).toBe(400);
    }
    expect((await request('/sessions', { requestId: randomUUID(), scriptSlug: 'escape-room', userId: other.user.id }, owner.accessToken)).status).toBe(400);
    expect((await request('/sessions/invalid/abandon', undefined, owner.accessToken)).status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  test('publisher failure returns 503 and a retry keeps the original message identity', async () => {
    const command = { commandId: randomUUID() };
    publish.mockRejectedValueOnce(new Error('private publisher failure'));
    const failed = await request(`/sessions/${sessionId}/rooms/room-1/open-door`, command, owner.accessToken);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private publisher failure');
    expect((await request(`/sessions/${sessionId}/rooms/room-1/open-door`, command, owner.accessToken)).status).toBe(202);
    expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
  });

  test('standalone publisher is unavailable and closing retains caller-owned database', async () => {
    await withGateway({ producer: undefined }, async (_app, url) => {
      expect((await request('/sessions', { requestId: randomUUID(), scriptSlug: 'escape-room' }, owner.accessToken, 'POST', url)).status).toBe(202);
      expect((await request(`/sessions/${sessionId}/abandon`, undefined, owner.accessToken, 'POST', url)).status).toBe(503);
    });
    expect(database.isInitialized).toBe(true);
    expect(await database.query('SELECT 1 AS alive')).toEqual([{ alive: 1 }]);
  });

  test('logout revokes the existing access token for sessions and profile', async () => {
    const credentials = await login('owner');
    expect((await request('/auth/logout', { refreshToken: credentials.refreshToken })).status).toBe(204);
    expect((await request('/sessions', { requestId: randomUUID(), scriptSlug: 'escape-room' }, credentials.accessToken)).status).toBe(401);
    expect((await request(`/sessions/${sessionId}/abandon`, undefined, credentials.accessToken)).status).toBe(401);
    expect((await request('/me', undefined, credentials.accessToken, 'GET')).status).toBe(401);
    expect((await request('/auth/refresh', { refreshToken: credentials.refreshToken })).status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });

  test('refresh rotation and logout-all preserve family and token-version enforcement', async () => {
    const first = await login('other');
    const second = await login('other');
    const response = await request('/auth/refresh', { refreshToken: first.refreshToken });
    expect(response.status).toBe(200);
    const rotated = await response.json();
    expect((await request('/auth/refresh', { refreshToken: first.refreshToken })).status).toBe(401);
    expect((await request('/me', undefined, rotated.accessToken, 'GET')).status).toBe(401);
    expect((await request('/auth/logout-all', undefined, second.accessToken)).status).toBe(204);
    expect((await request('/me', undefined, second.accessToken, 'GET')).status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });

  test('Swagger documents commands and CORS permits cookie credentials only for configured origins', async () => {
    const document = await (await fetch(`${base}/api/docs-json`)).json();
    expect(document.paths['/sessions'].post.responses['202']).toBeDefined();
    expect(document.paths['/sessions/{sid}/puzzles/{key}/inputs'].post.security).toEqual([{ 'access-token': [] }]);
    expect(document.paths['/sessions/{sid}/puzzles/{key}/inputs'].post.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'sid', in: 'path', required: true, schema: expect.objectContaining({ format: 'uuid' }) }),
      expect.objectContaining({ name: 'key', in: 'path', required: true, schema: expect.objectContaining({ pattern: '^[a-z0-9-]{1,64}$' }) }),
    ]));
    expect(document.components.schemas.SubmitInputDto.properties.input.oneOf).toHaveLength(3);
    for (const origin of ['http://localhost:5173', 'https://not-allowed.example']) {
      const response = await fetch(`${base}/sessions`, { method: 'OPTIONS', headers: { Origin: origin,
        'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
      expect(response.headers.get('access-control-allow-origin')).toBe(origin === 'http://localhost:5173' ? origin : null);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    }
    await withGateway({ config: { ...config, swaggerEnabled: false, corsOrigins: [] } }, async (_app, url) => {
      expect((await fetch(`${url}/api/docs-json`)).status).toBe(404);
      const response = await fetch(`${url}/health`, { headers: { Origin: 'http://localhost:5173' } });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  test('browser refresh rotates HttpOnly cookies, rejects missing CSRF header, and logout revokes access', async () => {
    const browser = (path, body, cookie, header = true) => fetch(`${base}/auth/browser/${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(header ? { 'X-Skillbreak-Browser': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body) });
    const signed = await browser('login', { username: 'owner', password });
    expect(signed.status).toBe(200);
    const tokens = await signed.json();
    expect(tokens.refreshToken).toBe('');
    const cookie = signed.headers.get('set-cookie');
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect((await browser('refresh', {}, cookie, false)).status).toBe(403);
    const refreshed = await browser('refresh', {}, cookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get('set-cookie')).not.toBe(cookie);
    const rotated = await refreshed.json();
    expect(rotated.refreshToken).toBe('');
    expect((await browser('logout', {}, refreshed.headers.get('set-cookie'))).status).toBe(204);
    expect((await request('/me', undefined, rotated.accessToken, 'GET')).status).toBe(401);
  });

  test('body limits, no-store responses and global throttling remain enabled', async () => {
    const missing = await request('/sessions', {});
    expect(missing.status).toBe(401);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    const oversized = await request('/sessions', { value: 'x'.repeat(17000) }, owner.accessToken);
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('cache-control')).toBe('no-store');
    await withGateway({}, async (_app, url) => {
      const codes = [];
      for (let attempt = 0; attempt < 101; attempt++) codes.push((await request('/sessions', {}, undefined, 'POST', url)).status);
      expect(codes.slice(0, 100)).toEqual(Array(100).fill(401));
      expect(codes[100]).toBe(429);
    });
    expect(publish).not.toHaveBeenCalled();
  });

  test('factory closes owned pools, rejects uninitialized supplied pools and cleans failed initialization', async () => {
    let ownedDatabase;
    await withGateway({ database: undefined }, async app => { ownedDatabase = app.get(DataSource); expect(ownedDatabase.isInitialized).toBe(true); });
    expect(ownedDatabase.isInitialized).toBe(false);
    const uninitialized = new DataSource(database.options);
    await expect(createGatewayApp({ config, database: uninitialized })).rejects.toThrow('must be initialized');
    const initialize = jest.spyOn(require('@nestjs/core').NestFactory, 'create').mockRejectedValueOnce(new Error('forced bootstrap failure'));
    const destroy = jest.spyOn(DataSource.prototype, 'destroy');
    await expect(createGatewayApp({ config })).rejects.toThrow('forced bootstrap failure');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(database.isInitialized).toBe(true);
    initialize.mockRestore();
  });
});