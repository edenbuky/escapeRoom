import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { GameEvent, SessionView } from '@team5/contracts';
import { InMemoryTransport } from '@team5/messaging';
import * as jwt from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { createEngineApp } from '../../src/bootstrap';
import { databaseOptions, loadConfig } from '../../src/config/config';
import { ROOM1 } from '../../src/modules/script-catalog/room1';

export async function until(check: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= end) throw new Error('Projection test condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

export function started(ownerId = randomUUID(), sessionId = randomUUID()): Extract<GameEvent, { type: 'SessionStarted' }> {
  const messageId = randomUUID();
  return { messageId, eventId: messageId, sessionId, sessionVersion: 1, occurredAt: new Date().toISOString(),
    type: 'SessionStarted', payload: { ownerId, scriptId: 'test', scriptVersion: 1, startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      room: { key: 'room-1', files: [], puzzles: [{ key: 'sql', family: 'sql', status: 'locked',
        sandbox: { generation: 1, status: 'none' }, latestResult: null }] } } };
}

export function fixtureView(event = started()): SessionView {
  return { sessionId: event.sessionId, version: 1, status: 'Active', currentRoom: event.payload.room,
    deadlineAt: event.payload.deadlineAt, endedAt: null, latestResult: null, revealedHints: [] };
}

export class ProjectionHarness {
  container?: string;
  database!: DataSource;
  app?: INestApplication;
  baseUrl = '';
  transport = new InMemoryTransport();
  secret = randomBytes(32);
  config = loadConfig({ DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
    JWT_ACCESS_SECRET: this.secret.toString('base64'), CORS_ORIGINS: 'http://localhost:5173' });

  async openDatabase(): Promise<void> {
    const password = randomBytes(32).toString('hex');
    this.container = execFileSync('docker', ['run', '--detach', '--rm', '--label', 'team5.test=projection-1.7',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=projection_test', '--publish', '127.0.0.1::5432',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', 'postgres:16-alpine'],
    { encoding: 'utf8', timeout: 60000 }).trim();
    const port = Number(execFileSync('docker', ['port', this.container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop());
    if (!Number.isInteger(port) || port < 1) throw new Error('Disposable PostgreSQL port unavailable');
    this.config.databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/projection_test`;
    this.database = new DataSource(databaseOptions(this.config));
    const end = Date.now() + 30000;
    while (!this.database.isInitialized) {
      try { await this.database.initialize(); }
      catch (error) {
        if (Date.now() >= end) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    await this.database.runMigrations();
  }

  async startApp(): Promise<void> {
    this.app = await createEngineApp({ config: this.config, database: this.database,
      consumer: this.transport, producer: this.transport,
      executor: { execute: async request => ({ commandId: request.commandId, stdout: `hash\n${ROOM1.danaPasswordSha256}\n`, stderr: '',
        exitCode: 0, timedOut: false, truncated: false }) } });
    await this.app.listen(0, '127.0.0.1');
    this.baseUrl = await this.app.getUrl();
  }

  token(ownerId: string, seconds = 900): string {
    return jwt.sign({ fid: randomUUID(), ver: 0 }, this.secret, { algorithm: 'HS256', subject: ownerId,
      issuer: 'escape-room-api', audience: 'escape-room-client', expiresIn: seconds });
  }

  async close(): Promise<void> {
    try { await this.app?.close(); }
    finally {
      try { if (this.database?.isInitialized) await this.database.destroy(); }
      finally {
        if (this.container) execFileSync('docker', ['stop', '--time', '1', this.container], { stdio: 'ignore', timeout: 30000 });
      }
    }
  }
}

export function changed<T extends GameEvent['type']>(sessionId: string, type: T,
  payload: Extract<GameEvent, { type: T }>['payload'], sessionVersion = 1): Extract<GameEvent, { type: T }> {
  const messageId = randomUUID();
  return { messageId, eventId: messageId, sessionId, sessionVersion, occurredAt: new Date().toISOString(),
    type, payload } as Extract<GameEvent, { type: T }>;
}

export class StreamReader {
  readonly frames: { view: SessionView; id: string; receivedAt: number }[] = [];
  readonly abort = new AbortController();
  ended = false;
  failure?: unknown;
  private reading?: Promise<void>;

  async open(url: string, token: string, lastId?: string): Promise<Response> {
    const response = await fetch(url, { signal: this.abort.signal, headers: {
      Authorization: `Bearer ${token}`, Connection: 'close', ...(lastId === undefined ? {} : { 'Last-Event-ID': lastId }),
    } });
    if (response.ok && response.body) {
      const reader = response.body.getReader();
      this.reading = (async () => {
        let buffer = '';
        const decoder = new TextDecoder();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = frame.split('\n').find(line => line.startsWith('data: '));
              if (data) this.frames.push({ view: JSON.parse(data.slice(6)) as SessionView,
                id: frame.split('\n').find(line => line.startsWith('id: '))?.slice(4) ?? '', receivedAt: Date.now() });
            }
          }
        } catch (error) { if (!this.abort.signal.aborted) this.failure = error; }
        finally { this.ended = true; reader.releaseLock(); }
      })();
    }
    return response;
  }

  async close(): Promise<void> { this.abort.abort(); await this.reading; }
}
