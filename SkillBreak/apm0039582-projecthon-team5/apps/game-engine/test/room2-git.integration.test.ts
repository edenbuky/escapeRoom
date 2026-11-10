import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PlayerCommand, PuzzleInput } from '@team5/contracts';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { createEngineApp } from '../src/bootstrap';
import { databaseOptions, loadConfig } from '../src/config/config';
import { EmbeddedDriver, embeddedImageDigest } from '../src/modules/sandbox/embedded-driver';
import { SandboxExecutorService } from '../src/modules/sandbox/sandbox-executor';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { publishRoom2 } from '../src/modules/script-catalog/publish-room2';
import { publishSqlRoom1 } from '../src/modules/script-catalog/publish-sql-room1';
import { ROOM1 } from '../src/modules/script-catalog/room1';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';
import { EngineRepository } from '../src/modules/sessions/engine.repository';
import { EngineService } from '../src/modules/sessions/engine.service';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';

// Real worker + embedded driver + executor + engine on a disposable PostgreSQL:
// RUN_ROOM2_GIT_DB_TESTS=1 npx jest --config jest.config.cjs --runInBand test/room2-git.integration.test.ts
const databaseTests = process.env.RUN_ROOM2_GIT_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(240000);

databaseTests('Room 2 git sandbox through the real engine (disposable PostgreSQL, embedded driver)', () => {
  let container: string | undefined;
  let database: DataSource;
  let app: INestApplication;
  let engine: EngineService;
  let repository: EngineRepository;
  const userId = randomUUID();
  const sessionId = randomUUID();

  const command = (type: 'StartSession' | 'OpenDoor' | 'EnterRoom'): PlayerCommand => type === 'StartSession'
    ? { type, messageId: randomUUID(), sessionId, payload: { userId, scriptSlug: 'escape-room' } }
    : { type, messageId: randomUUID(), sessionId, payload: { userId, roomKey: 'room-1' } };
  const submit = (puzzleKey: string, input: PuzzleInput, messageId = randomUUID()): PlayerCommand =>
    ({ type: 'SubmitInput', messageId, sessionId, payload: { userId, puzzleKey, input } });
  const load = () => repository.load(database.manager, sessionId);
  const puzzle = async (key: string) => (await load())!.puzzles.find(candidate => candidate.key === key)!;
  async function until(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 60000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    const password = randomBytes(32).toString('hex');
    container = execFileSync('docker', ['run', '--detach', '--rm', '--label', 'team5.test=room2-git',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=room2_git', '--publish', '127.0.0.1::5432',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', 'postgres:16-alpine'], { encoding: 'utf8', timeout: 60000 }).trim();
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop());
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/room2_git`;
    const deadline = Date.now() + 30000;
    for (;;) {
      const client = new Client({ connectionString: url });
      try { await client.connect(); await client.query('CREATE SCHEMA IF NOT EXISTS team5'); await client.end(); break; }
      catch (error) {
        await client.end().catch(() => undefined);
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    const config = loadConfig({ DATABASE_URL: url, SANDBOX_ENABLED: 'true', SANDBOX_DRIVER: 'embedded' });
    database = new DataSource(databaseOptions(config));
    await database.initialize();
    await database.runMigrations();
    const catalog = new CatalogRepository(database);
    await catalog.seed();
    const driver = new EmbeddedDriver();
    await publishSqlRoom1(database, embeddedImageDigest(), driver);
    await driver.onModuleDestroy();
    await catalog.publishGameplay();
    await publishRoom2(database);
    app = await createEngineApp({ config, database });
    engine = app.get(EngineService);
    repository = app.get(EngineRepository);
  });

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      try { if (database?.isInitialized) await database.destroy(); }
      finally { if (container) execFileSync('docker', ['stop', '--time', '1', container], { stdio: 'ignore', timeout: 30000 }); }
    }
  });

  test('Room 1 SQL still solves, then Room 2 provisions the git sandbox and the key solves it', async () => {
    await engine.handle(command('StartSession'));
    await until(async () => (await puzzle('idan-db')).sandbox.status === 'ready', 'the SQL sandbox');
    await engine.handle(submit('idan-db', { kind: 'command', command:
      "SELECT e.username, l.password_hash FROM employees e JOIN logs l ON l.employee_id = e.id WHERE l.event = 'auth'" }));
    expect((await puzzle('idan-db')).status).toBe('solved');
    await engine.handle(submit('hash-cracker', { kind: 'answer', answer: ROOM1.danaPasswordSha256 }));
    await engine.handle(submit('dana-login', { kind: 'credentials', username: ROOM1.danaUsername, password: ROOM1.danaPassword }));
    await engine.handle(command('OpenDoor'));
    await engine.handle(command('EnterRoom'));
    expect(await load()).toMatchObject({ roomKey: 'room-2' });

    // Entering the room provisions the git sandbox; commands are refused until it is ready.
    await until(async () => (await puzzle('nethanel-git')).sandbox.status === 'ready', 'the git sandbox');
    const instance = await database.query(`SELECT status,seed_ref,template_ref FROM team5.sandbox_instances
      WHERE sandbox_id=$1`, [sandboxIdentity(sessionId, 'nethanel-git', 1).podName]);
    expect(instance).toEqual([{ status: 'ready', seed_ref: 'room2-git-v1', template_ref: 'nethanel-git@1' }]);

    const log = submit('nethanel-git', { kind: 'command', command: 'git log --oneline' });
    await engine.handle(log);
    expect((await puzzle('nethanel-git')).latestResult).toMatchObject({ verdict: 'progress', output: expect.stringContaining('Security fix') });

    await engine.handle(submit('nethanel-git', { kind: 'command', command: 'vim README.md' }));
    expect((await puzzle('nethanel-git')).latestResult).toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });
    await engine.handle(submit('nethanel-git', { kind: 'command', command: 'git log | cat' }));
    expect((await puzzle('nethanel-git')).latestResult).toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });

    const solving = submit('nethanel-git', { kind: 'command', command: 'git show HEAD~1:server.key' });
    await engine.handle(solving);
    expect((await puzzle('nethanel-git'))).toMatchObject({ status: 'solved',
      latestResult: { verdict: 'solved', output: expect.stringContaining(room2Scenario.privateKeyPem.trimEnd()) } });
    expect((await puzzle('rsa-decryptor')).status).toBe('open');

    // The executor stores one result per commandId: redelivery returns it without running the command again.
    const executor = app.get(SandboxExecutorService);
    const identity = sandboxIdentity(sessionId, 'nethanel-git', 1);
    const commandId = randomUUID();
    const first = await executor.execute({ ...identity, commandId, command: 'git commit --allow-empty -m once' });
    const second = await executor.execute({ ...identity, commandId, command: 'git commit --allow-empty -m once' });
    expect(second).toEqual(first);
    await expect(executor.execute({ ...identity, commandId, command: 'git log' })).rejects.toMatchObject({ code: 'commandConflict' });
    const history = await executor.execute({ ...identity, commandId: randomUUID(), command: 'git log --oneline' });
    expect(history.stdout.split('\n').filter(line => line.includes('once'))).toHaveLength(1);
    expect(first.stdout).toMatch(/^\[main [0-9a-f]{7}\] once\n$/);
  });

  test('the rest of the winning path: RSA, TLS, door code, OpenDoor, EnterRoom end Escaped and every sandbox is destroyed', async () => {
    const door = (type: 'OpenDoor' | 'EnterRoom'): PlayerCommand => ({ type, messageId: randomUUID(), sessionId, payload: { userId, roomKey: 'room-2' } });
    await engine.handle(submit('rsa-decryptor', { kind: 'rsa', privateKey: room2Scenario.privateKeyPem,
      encryptedPms: room2Scenario.rsa.encryptedPmsHex, modulus: room2Scenario.rsa.modulusHex }));
    expect((await puzzle('rsa-decryptor')).latestResult).toMatchObject({ verdict: 'solved', output: room2Scenario.rsa.expectedPmsHex });
    await engine.handle(submit('tls-decryptor', { kind: 'tls', pms: room2Scenario.rsa.expectedPmsHex, clientRandom: room2Scenario.tls.clientRandomHex }));
    expect((await puzzle('tls-decryptor')).latestResult).toMatchObject({ verdict: 'solved', output: 'The file has been decrypted' });
    await engine.handle(submit('door', { kind: 'answer', answer: '4000000131941182' }));
    expect((await puzzle('door')).status).toBe('open');
    await engine.handle(submit('door', { kind: 'answer', answer: room2Scenario.cardNumber }));
    expect((await puzzle('door')).status).toBe('solved');
    await engine.handle(door('OpenDoor'));
    await engine.handle(door('EnterRoom'));
    expect(await load()).toMatchObject({ status: 'Escaped' });
    await until(async () => (await database.query('SELECT status FROM team5.sandbox_instances WHERE session_id=$1', [sessionId]))
      .every((row: { status: string }) => row.status === 'destroyed'), 'every sandbox to be destroyed');
  });
});
