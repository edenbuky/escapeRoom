import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, Module, NotFoundException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard, RolesGuard } from '../auth/jwt-auth.guard';
import { SessionsController } from './sessions.controller';
import { SESSION_PUBLISHER, SessionsService } from './sessions.service';
import { SessionOwnerClient } from './session-owner.client';

const userId = randomUUID();
const sessionId = randomUUID();
const secret = Buffer.alloc(32, 13);
const publish = jest.fn();
const getOwner = jest.fn();
const session = jest.fn();
const account = { select: jest.fn().mockReturnThis(), from: jest.fn().mockReturnThis(), innerJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(), getRawOne: jest.fn() };
@Module({ controllers: [SessionsController], providers: [SessionsService, JwtAuthGuard, RolesGuard,
  { provide: SESSION_PUBLISHER, useValue: { publish } }, { provide: SessionOwnerClient, useValue: { getOwner, session } },
  { provide: DataSource, useValue: { createQueryBuilder: () => account } },
  { provide: AuthService, useValue: { jwtConfig: { secret, issuer: 'test', audience: 'test', ttlSeconds: 900 } } },
] })
class TestModule {}

describe('session HTTP routes', () => {
  let app: INestApplication;
  let base: string;
  let token: string;
  const route = `/sessions/${sessionId}/puzzles/idan-db/inputs`;
  const body = { commandId: randomUUID(), input: { kind: 'command', command: 'SELECT 1' } };
  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    token = jwt.sign({ sub: userId, fid: randomUUID(), ver: 0 }, secret, { issuer: 'test', audience: 'test', expiresIn: 900 });
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    publish.mockReset().mockResolvedValue(undefined);
    getOwner.mockReset().mockResolvedValue({ ownerId: userId });
    session.mockReset().mockResolvedValue({ sessionId });
    account.getRawOne.mockReset().mockResolvedValue({ id: userId, role: 'player', username: 'player' });
  });
  async function post(path: string, value?: unknown, access = token) {
    return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(access ? { Authorization: `Bearer ${access}` } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) });
  }
  it('accepts retry-stable starts, submits and abandonment', async () => {
    const start = { scriptSlug: 'escape-room', requestId: randomUUID() };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await post('/sessions', start)).status).toBe(202);
      expect((await post(route, body)).status).toBe(202);
      expect((await post(`/sessions/${sessionId}/abandon`)).status).toBe(202);
    }
    expect(publish.mock.calls.slice(0, 2)).toEqual(publish.mock.calls.slice(2));
    expect(session.mock.calls).toEqual(Array(2).fill(['start', { ...start, userId }]));
  });
  it('resumes the authenticated owner and accepts explicit door commands', async () => {
    const resumed = await fetch(`${base}/sessions/resume`, { headers: { Authorization: `Bearer ${token}` } });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ sessionId });
    expect(session).toHaveBeenCalledWith(`users/${userId}/resume`);
    for (const action of ['open-door', 'enter']) {
      expect((await post(`/sessions/${sessionId}/rooms/room-1/${action}`, { commandId: randomUUID() })).status).toBe(202);
    }
    expect(publish.mock.calls.map(([, command]) => command.type)).toEqual(['OpenDoor', 'EnterRoom']);
    expect((await fetch(`${base}/sessions/resume`)).status).toBe(401);
  });
  it.each(['player', 'admin'])('denies non-owner %s without publishing', async role => {
    account.getRawOne.mockResolvedValue({ id: userId, role, username: 'player' });
    getOwner.mockResolvedValue({ ownerId: randomUUID() });
    expect((await post(route, body)).status).toBe(403);
    expect((await post(`/sessions/${sessionId}/abandon`)).status).toBe(403);
    expect(publish).not.toHaveBeenCalled();
  });
  it.each([[new NotFoundException(), 404], [new ServiceUnavailableException(), 503]])('preserves lookup failure status', async (error, code) => {
    getOwner.mockRejectedValue(error);
    expect((await post(route, body)).status).toBe(code);
    expect((await post(`/sessions/${sessionId}/abandon`)).status).toBe(code);
    expect(publish).not.toHaveBeenCalled();
  });
  it('keeps JWT and revocation enforcement before ownership lookup', async () => {
    expect((await post('/sessions', {}, '')).status).toBe(401);
    account.getRawOne.mockResolvedValue(undefined);
    expect((await post(route, body)).status).toBe(401);
    expect((await post(`/sessions/${sessionId}/abandon`)).status).toBe(401);
    expect(getOwner).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it('returns 503 instead of acceptance when admission or publication fails', async () => {
    publish.mockRejectedValue(new Error('private data'));
    session.mockRejectedValue(new ServiceUnavailableException('Session service unavailable'));
    for (const [path, value] of [['/sessions', { scriptSlug: 'escape-room', requestId: randomUUID() }],
      [route, body], [`/sessions/${sessionId}/abandon`, undefined]] as const) {
      const response = await post(path, value);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private data');
    }
  });
  it.each([null, [], {}, { query: 'SELECT 1' }, { kind: 'command', command: '' },
    { kind: 'answer', answer: 42 }, { kind: 'credentials', username: 'dana' },
    { kind: 'command', command: 'SELECT 1', userId }, { kind: 'command', command: 'x'.repeat(8192) },
    { kind: 'answer', answer: '\u00e9'.repeat(4100) },
    { kind: 'rsa', privateKey: 'k', encryptedPms: 'e' }, { kind: 'rsa', privateKey: 'k', encryptedPms: '', modulus: 'n' },
    { kind: 'rsa', privateKey: 'k', encryptedPms: 'e', modulus: 'n', extra: 'x' }, { kind: 'rsa', privateKey: 'k'.repeat(8192), encryptedPms: 'e', modulus: 'n' },
    { kind: 'tls', pms: 'p' }, { kind: 'tls', pms: 'p', clientRandom: 7 }, { kind: 'tls', pms: 'p', clientRandom: 'c', userId },
    { kind: 'dns', name: 'x' }])('rejects invalid input %# before lookup', async input => {
    expect((await post(route, { ...body, input })).status).toBe(400);
    expect(getOwner).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'answer', answer: 'hash' }, { kind: 'credentials', username: 'dana', password: 'secret' },
    { kind: 'rsa', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', encryptedPms: 'ab12', modulus: 'cd34' },
    { kind: 'tls', pms: '0303ab', clientRandom: 'cd34' }])
  ('accepts canonical input %#', async input => {
    expect((await post(route, { ...body, input })).status).toBe(202);
    expect(publish.mock.calls[0][1].payload).toEqual({ userId, puzzleKey: 'idan-db', input });
  });
  it('rejects malformed identifiers and extra identity fields', async () => {
    for (const value of [{ scriptSlug: 'bad slug', requestId: randomUUID() },
      { scriptSlug: 'escape-room', requestId: 'invalid' }, { scriptSlug: 'escape-room', requestId: randomUUID(), userId }]) {
      expect((await post('/sessions', value)).status).toBe(400);
    }
    expect((await post(route, { ...body, commandId: 'bad' })).status).toBe(400);
    expect((await post(route, { ...body, ownerId: userId })).status).toBe(400);
    expect((await post(`/sessions/invalid/abandon`)).status).toBe(400);
    expect((await post(`/sessions/${sessionId}/puzzles/INVALID/inputs`, body)).status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });
});