import { readFile, open, statfs, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import pg from 'pg';
import QueryStream from 'pg-query-stream';

const expectedHash = 'ea7e95b64496fb6f22959c4a2f6442ab5bd4d8a2ba9c5a0ff9404ee792a6ac90';
const mode = process.argv[2];

async function input() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 32768) throw new Error('invalidInput');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || value.version !== 1) throw new Error('invalidInput');
  return value;
}

function reachable(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function inspect() {
  const request = await input();
  if (!Array.isArray(request.targets) || request.targets.length !== 4
    || request.targets.some(target => !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(target.host)
      || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) throw new Error('invalidInput');
  let readOnlyRoot = false;
  try { const file = await open('/opt/sql/preflight-write', 'wx'); await file.close(); }
  catch (error) { if (error.code !== 'EROFS') throw error; readOnlyRoot = true; }
  const volumes = await Promise.all(['/var/lib/postgresql/data', '/run/postgresql', '/tmp'].map(async path => {
    const fs = await statfs(path);
    return fs.bsize * fs.blocks;
  }));
  const status = await readFile('/proc/self/status', 'utf8');
  const pidQuota = await probePidQuota();
  return { version: 1, uid: process.getuid(), gid: process.getgid(), readOnlyRoot, volumes,
    noCapabilities: /^CapEff:\s+0+$/m.test(status),
    noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status),
    containerPidsMax: (await readFile('/sys/fs/cgroup/pids.max', 'utf8')).trim(),
    pidQuota: pidQuota.enforced,
    pidQuotaEvidence: pidQuota,
    memory: Number((await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim()),
    cpu: (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim(),
    databaseTcp: await reachable('127.0.0.1', 5432),
    reachable: await Promise.all(request.targets.map(target => reachable(target.host, target.port))) };
}

async function probePidQuota() {
  const children = [];
  const events = async () => {
    const text = await readFile('/sys/fs/cgroup/pids.events', 'utf8');
    const match = text.match(/^max (\d+)$/m);
    if (!match) throw new Error('pidQuotaUnknown');
    return Number(match[1]);
  };
  const before = await events();
  let exhausted = false;
  try {
    for (let index = 0; index < 65; index++) {
      const child = spawn('/bin/sleep', ['10'], { stdio: 'ignore' });
      const closed = new Promise(resolve => child.once('close', resolve));
      try {
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        children.push({ child, closed });
      } catch (error) {
        await closed;
        if (error.code !== 'EAGAIN') throw error;
        exhausted = true;
        break;
      }
    }
    const current = Number((await readFile('/sys/fs/cgroup/pids.current', 'utf8')).trim());
    const after = await events();
    // The pod's 64-PID ancestor includes one sandbox process outside this container's cgroup.
    // Its rejection does not increment the child's local pids.events counter.
    return { enforced: exhausted && current === 63, exhausted, current, before, after, children: children.length };
  } finally {
    for (const { child } of children) child.kill('SIGTERM');
    await Promise.all(children.map(({ closed }) => closed));
  }
}

async function ready() {
  const marker = await readFile(`${process.env.PGDATA}/.skillbreak-seed`, 'utf8');
  if (marker.trim() !== 'room1-sql-v1') throw new Error('seedFailed');
  const admin = new pg.Client({ host: '/run/postgresql', database: 'puzzle', user: 'sandbox_owner',
    connectionTimeoutMillis: 1000, query_timeout: 1000, application_name: 'sandbox-readiness' });
  try {
    await admin.connect();
    const policy = await admin.query(`SELECT current_setting('listen_addresses') AS listen,
      rolsuper,rolcreatedb,rolcreaterole,rolreplication,
      has_database_privilege('sandbox_player','puzzle','TEMPORARY') AS temp,
      has_schema_privilege('sandbox_player','public','CREATE') AS create,
      has_table_privilege('sandbox_player','employees','UPDATE') AS update
      FROM pg_roles WHERE rolname='sandbox_player'`);
    const row = policy.rows[0];
    if (!row || row.listen !== '' || row.rolsuper || row.rolcreatedb || row.rolcreaterole
      || row.rolreplication || row.temp || row.create || row.update) throw new Error('seedFailed');
  } finally { await admin.end(); }
  const player = new pg.Client({ host: '/run/postgresql', database: 'puzzle', user: 'sandbox_player',
    connectionTimeoutMillis: 1000, query_timeout: 1000, application_name: 'sandbox-readiness' });
  try {
    await player.connect();
    await player.query('BEGIN READ ONLY');
    const result = await player.query(`SELECT e.username,l.password_hash FROM employees e
      JOIN logs l ON l.employee_id=e.id WHERE l.event='auth'`);
    if (result.rows.length !== 1 || result.rows[0].username !== 'danaZ22'
      || result.rows[0].password_hash !== expectedHash) throw new Error('seedFailed');
    await player.query('ROLLBACK');
    return { version: 1, ready: true, seedRef: 'room1-sql-v1' };
  } finally { await player.end(); }
}

async function seedStatus(request) {
  if (request.probeSeed !== true) throw new Error('invalidInput');
  try {
    const marker = await readFile(`${process.env.PGDATA}/.skillbreak-seed`, 'utf8');
    if (marker.trim() !== 'room1-sql-v1') throw new Error('seedFailed');
    return { version: 1, seeded: true, seedRef: 'room1-sql-v1' };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, seeded: false };
  }
}

const journalRoot = '/tmp/sql-executions';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateTokenRequest(request) {
  if (!request || request.version !== 1 || typeof request.executionToken !== 'string'
    || !uuid.test(request.executionToken)) throw new Error('invalidInput');
}

function validateQueryRequest(request) {
  validateTokenRequest(request);
  if (typeof request.commandId !== 'string' || !uuid.test(request.commandId)
    || typeof request.command !== 'string' || !request.command.trim()
    || request.command.length > 4096 || request.command.includes('\0')) throw new Error('invalidInput');
}

function encodeRecord(cells) {
  return `${cells.map(cell => cell === null ? '\\N' : String(cell)
    .replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n')).join('\t')}\n`;
}

function appendRecord(result, cells) {
  const record = encodeRecord(cells);
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) + Buffer.byteLength(record) > 65536) {
    result.truncated = true;
    return false;
  }
  result.stdout += record;
  return true;
}

function databaseClient(user, applicationName, queryTimeout = 500) {
  return new pg.Client({
    host: '/run/postgresql', database: 'puzzle', user,
    connectionTimeoutMillis: 500, query_timeout: queryTimeout, application_name: applicationName,
  });
}

async function closeClient(client) {
  let timer;
  try {
    await Promise.race([
      client.end(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          client.connection.stream.destroy();
          reject(new Error('runtimeUnavailable'));
        }, 750);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function backendExists(executionToken, terminate = false) {
  const owner = await readJson(`${journalRoot}/${executionToken}/owner`);
  const identity = owner?.backendPid !== undefined && owner?.backendStart !== undefined;
  const admin = databaseClient('sandbox_owner', 'sandbox-cancellation');
  admin.on('error', () => {});
  try {
    await admin.connect();
    const result = await admin.query(
      `SELECT pid${terminate ? ',pg_terminate_backend(pid)' : ''} FROM pg_stat_activity
       WHERE datname=$1 AND usename=$2 AND ${identity
        ? 'pid=$3::integer AND backend_start=$4::timestamptz' : 'application_name=$3'}`,
      identity ? ['puzzle', 'sandbox_player', owner.backendPid, owner.backendStart]
        : ['puzzle', 'sandbox_player', `sandbox-query:${executionToken}`],
    );
    return result.rows.length !== 0;
  } finally { await closeClient(admin); }
}

async function confirmStopped(executionToken, terminate = false) {
  if (terminate) await backendExists(executionToken, true);
  const deadline = Date.now() + 750;
  do {
    if (!await backendExists(executionToken)) return;
    await pause(20);
  } while (Date.now() < deadline);
  throw new Error('runtimeUnavailable');
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function saveJson(path, value) {
  const staging = `${path}.${process.pid}`;
  await writeFile(staging, JSON.stringify(value), { mode: 0o600 });
  await rename(staging, path);
}

async function claimToken(executionToken) {
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  // Never evict consumed identities; the memory-backed volume bounds journal storage.
  const path = `${journalRoot}/${executionToken}`;
  try {
    await mkdir(path, { mode: 0o700 });
    return { path, claimed: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { path, claimed: false };
  }
}

async function tokenStatus(request, cancel = false) {
  validateTokenRequest(request);
  const { path, claimed } = await claimToken(request.executionToken);
  if (claimed || cancel) await writeFile(`${path}/cancel`, '', { mode: 0o600 });
  if (claimed) await saveJson(`${path}/terminal`, { cancelled: true });
  const terminal = await readJson(`${path}/terminal`);
  const owner = await readJson(`${path}/owner`);
  let helperAlive = false;
  if (!terminal && owner) {
    try { process.kill(owner.pid, 0); helperAlive = true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (cancel) await confirmStopped(request.executionToken, true);
  const backendAlive = await backendExists(request.executionToken);
  // A directory without owner metadata can be a query between claim and dispatch.
  const quiesced = !backendAlive && !helperAlive && (claimed || terminal !== null || owner !== null);
  return { version: 1, executionToken: request.executionToken, quiesced };
}

function safeDiagnostic(error) {
  if (error.code === '42501' || error.code === '25006') return 'SQL operation is not permitted.\n';
  if (error.code === '42601') return 'SQL syntax is invalid; submit one statement.\n';
  if (typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) return 'SQL query failed.\n';
  throw new Error('runtimeUnavailable');
}

async function runQuery(request) {
  validateQueryRequest(request);
  const { path, claimed } = await claimToken(request.executionToken);
  const fingerprint = createHash('sha256').update(request.commandId).update('\0').update(request.command).digest('hex');
  if (!claimed) {
    // The engine retains results. This small pod journal retains only consumed identities.
    throw new Error('executionConsumed');
  }
  await saveJson(`${path}/owner`, { pid: process.pid, fingerprint });
  const result = {
    version: 1, commandId: request.commandId, stdout: '', stderr: '',
    exitCode: null, timedOut: false, truncated: false,
  };
  // Streaming uses the independent watchdog, not pg's per-cursor query timer.
  const player = databaseClient('sandbox_player', `sandbox-query:${request.executionToken}`, 0);
  player.on('error', () => {});
  let stopped = false;
  let stopPromise;
  let stopFailure;
  let queryStream;
  let checking = false;
  const stop = timedOut => {
    if (timedOut) result.timedOut = true;
    stopped = true;
    stopPromise ??= confirmStopped(request.executionToken, true).catch(error => {
      stopFailure = error;
      queryStream?.destroy(error);
      player.connection.stream.destroy();
    });
    return stopPromise;
  };
  const cancelled = async () => {
    try { await readFile(`${path}/cancel`); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const disconnected = () => { void stop(false); };
  process.on('SIGHUP', disconnected);
  process.on('SIGTERM', disconnected);
  const timer = setTimeout(() => { void stop(true); }, 5000);
  const watcher = setInterval(() => {
    if (checking) return;
    checking = true;
    void cancelled().then(value => value && stop(false)).catch(error => {
      stopFailure = error;
      return stop(false);
    }).finally(() => { checking = false; });
  }, 50);
  let failure;
  try {
    if (await cancelled()) await stop(false);
    if (!stopped) await player.connect();
    if (!stopped) {
      const metadata = await player.query('SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()');
      const backendStart = metadata.rows[0]?.backend_start;
      if (!Number.isInteger(player.processID) || typeof backendStart !== 'string') throw new Error('runtimeUnavailable');
      // application_name is player-mutable; PID plus server start time is the durable cancellation identity.
      await saveJson(`${path}/owner`, { pid: process.pid, fingerprint, backendPid: player.processID, backendStart });
    }
    if (!stopped) await player.query('BEGIN READ ONLY');
    if (!stopped) await player.query("SET LOCAL statement_timeout = '5s'");
    if (!stopped && await cancelled()) await stop(false);
    if (!stopped) {
      // Parse/Bind uses the extended protocol, which rejects multiple statements independently of the engine.
      const stream = player.query(new QueryStream(request.command, [], {
        rowMode: 'array', batchSize: 1, types: { getTypeParser: () => value => value },
      }));
      queryStream = stream;
      let headerWritten = false;
      const header = () => {
        if (headerWritten) return true;
        headerWritten = true;
        return appendRecord(result, stream.cursor._result.fields.map(field => field.name));
      };
      for await (const row of stream) {
        if (stopped || !header() || !appendRecord(result, row)) {
          await stop(false);
          break;
        }
      }
      if (!stopped && !stream.cursor._result.command) {
        throw Object.assign(new Error('invalidSql'), { code: '42601' });
      }
      if (!stopped && !header()) await stop(false);
      if (!stopped) await player.query('ROLLBACK');
      if (!stopped) result.exitCode = 0;
    }
  } catch (error) {
    if (error.code === '57014') await stop(true);
    else if (!stopped) {
      try { result.stderr = safeDiagnostic(error); result.exitCode = 1; }
      catch (infrastructureError) { failure = infrastructureError; }
    }
  } finally {
    try {
      await closeClient(player);
      if (stopPromise) await stopPromise;
      await confirmStopped(request.executionToken);
    } catch (error) { failure = error; }
    clearTimeout(timer);
    clearInterval(watcher);
    process.removeListener('SIGHUP', disconnected);
    process.removeListener('SIGTERM', disconnected);
  }
  if (failure || stopFailure) throw new Error('runtimeUnavailable');
  if (stopped) result.exitCode = null;
  if (result.timedOut) result.stderr = 'SQL execution timed out.\n';
  else if (stopped && !result.truncated) result.stderr = 'SQL execution cancelled.\n';
  // Error/deadline diagnostics take precedence over partial output.
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 65536) result.stdout = '';
  await saveJson(`${path}/terminal`, { quiesced: true });
  return result;
}

try {
  if (mode === 'probe-server') {
    const server = createServer(socket => { socket.end('sandbox-preflight\n'); });
    server.on('error', () => { process.stderr.write('Sandbox probe server failed.\n'); process.exitCode = 1; });
    server.listen(18080, '0.0.0.0');
  } else {
    if (!['ready', 'inspect', 'status', 'query', 'cancel'].includes(mode)) throw new Error('unsupportedMode');
    let result;
    if (mode === 'ready') result = await ready();
    else if (mode === 'inspect') result = await inspect();
    else {
      const request = await input();
      result = mode === 'query' ? await runQuery(request)
        : mode === 'status' && request.probeSeed === true ? await seedStatus(request)
          : await tokenStatus(request, mode === 'cancel');
    }
    const envelope = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(envelope) > 512 * 1024) throw new Error('runtimeUnavailable');
    process.stdout.write(envelope, error => { if (error) process.exitCode = 1; });
  }
} catch {
  process.stderr.write('Sandbox helper operation failed.\n');
  process.exitCode = 1;
}
