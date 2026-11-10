import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';

// Runs in a worker thread: WebAssembly Postgres does not enforce statement_timeout, so the host
// terminates this thread when a query overruns and starts a fresh one from the snapshot.
interface Start { fixturePath: string; snapshot?: ArrayBuffer }
type Request = { id: number; type: 'ready' } | { id: number; type: 'query'; command: string; cursor: boolean; limit: number };

const start = workerData as Start;

// Same record encoding as sandboxes/sql/query-helper.mjs, so sql-result.ts decodes both identically.
function encodeRecord(cells: unknown[]): string {
  return `${cells.map(cell => cell === null ? '\\N' : String(cell)
    .replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n')).join('\t')}\n`;
}

// PGlite's multi-statement runner (SQL text inside WebAssembly; no process or shell is involved).
function runScript(db: PGlite, sql: string): Promise<unknown> {
  return db.exec.call(db, sql);
}

async function open(): Promise<{ db: PGlite; snapshot: ArrayBuffer }> {
  if (start.snapshot) {
    return { db: await PGlite.create({ loadDataDir: new Blob([start.snapshot]), database: 'puzzle' }), snapshot: start.snapshot };
  }
  // The fixture grants on DATABASE puzzle, so that database must exist before it runs.
  const boot = await PGlite.create();
  await boot.query('CREATE DATABASE puzzle');
  const base = await boot.dumpDataDir('none');
  await boot.close();
  const db = await PGlite.create({ loadDataDir: base, database: 'puzzle' });
  await runScript(db, readFileSync(start.fixturePath, 'utf8'));
  return { db, snapshot: await (await db.dumpDataDir('none')).arrayBuffer() };
}

// Every player statement runs read-only as sandbox_player and is rolled back, which also undoes any
// session change the statement made (role, settings).
async function playerTransaction<T>(db: PGlite, work: () => Promise<T>): Promise<T> {
  await db.query('BEGIN READ ONLY');
  try {
    await db.query('SET LOCAL ROLE sandbox_player');
    await db.query("SET LOCAL statement_timeout = '5s'");
    return await work();
  } finally { await db.query('ROLLBACK'); }
}

async function main(): Promise<void> {
  const { db, snapshot } = await open();
  // Raw Postgres text for every type, matching the container helper's identity type parser.
  const oids = (await db.query<{ oid: number }>('SELECT oid FROM pg_type')).rows;
  const parsers = Object.fromEntries(oids.map(({ oid }) => [oid, (value: string) => value]));
  const options = { rowMode: 'array' as const, parsers };
  parentPort!.postMessage({ type: 'started', snapshot });

  parentPort!.on('message', (request: Request) => void (async () => {
    try {
      if (request.type === 'ready') {
        const rows = await playerTransaction(db, async () => (await db.query(`SELECT e.username,l.password_hash
          FROM employees e JOIN logs l ON l.employee_id=e.id WHERE l.event='auth'`, [], options)).rows);
        parentPort!.postMessage({ id: request.id, result: { ok: true, rows } });
        return;
      }
      const output = { stdout: '', truncated: false };
      const append = (cells: unknown[]) => {
        const record = encodeRecord(cells);
        if (Buffer.byteLength(output.stdout) + Buffer.byteLength(record) > request.limit) { output.truncated = true; return false; }
        output.stdout += record;
        return true;
      };
      await playerTransaction(db, async () => {
        if (!request.cursor) {
          const result = await db.query(request.command, [], options);
          if (append(result.fields.map(field => field.name))) for (const row of result.rows) if (!append(row as unknown[])) break;
          return;
        }
        // Row queries stream through a cursor so a huge result stops at the output limit, like the helper.
        await db.query(`DECLARE player_rows NO SCROLL CURSOR FOR ${request.command}`);
        let header = false;
        for (;;) {
          const batch = await db.query('FETCH FORWARD 100 FROM player_rows', [], options);
          if (!header) { header = true; if (!append(batch.fields.map(field => field.name))) return; }
          if (!batch.rows.length) return;
          for (const row of batch.rows) if (!append(row as unknown[])) return;
        }
      });
      parentPort!.postMessage({ id: request.id, result: { ok: true, ...output } });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      parentPort!.postMessage({ id: request.id, result: { ok: false, code } });
    }
  })());
}

main().catch(() => process.exit(1));
