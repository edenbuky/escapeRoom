import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { decodeSqlRows } from '../src/modules/sandbox/sql-result';
import { ExecResult } from '../src/modules/sandbox/sandbox.contracts';

const source = readFileSync(resolve(__dirname, '../../../sandboxes/sql/query-helper.mjs'), 'utf8');

function helperFunctions() {
  const declarations = source.replace(/^import .*;\n/gm, '').split("\ntry {\n  if (mode === 'probe-server')")[0];
  return new Function('process', 'Buffer', `${declarations}
    return { encodeRecord, appendRecord, validateQueryRequest, validateTokenRequest };`)(
    { argv: [] }, Buffer,
  ) as {
    encodeRecord(cells: (string | null)[]): string;
    appendRecord(result: { stdout: string; stderr: string; truncated: boolean }, cells: (string | null)[]): boolean;
    validateQueryRequest(value: unknown): void;
    validateTokenRequest(value: unknown): void;
  };
}

describe('isolated helper boundary', () => {
  it('encodes positional escaped records losslessly', () => {
    const { encodeRecord } = helperFunctions();
    const cells = [null, '', '\\N', '\\', '\t\r\n', 'λ😀', '\\u0061'];
    expect(decodeSqlRows(encodeRecord(cells.map(() => 'duplicate')) + encodeRecord(cells))).toEqual([cells]);
  });

  const request = {
    version: 1, executionToken: '9a1d3ee2-9865-48c6-b2f6-8fd1ea0f48b7',
    commandId: '5c6e574b-bb17-4ca2-95e3-e113773afdd9', command: 'SELECT 1',
  };

  function queryHarness(rows: (string | null)[][] = [['hello']], options: {
    wait?: boolean; unkillable?: boolean; renamedApplication?: boolean;
  } = {}) {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const backends = new Map<string, { release: () => void }>();
    const dispatched: string[] = [];
    const signals = new Map<string, () => void>();
    let release = () => {};
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
    const declarations = source.replace(/^import .*;\n/gm, '').split("\ntry {\n  if (mode === 'probe-server')")[0];
    class Stream {
      cursor = { _result: { fields: [{ name: 'duplicate' }], command: 'SELECT' } };
      constructor(readonly text: string, _values: unknown[], readonly config: unknown) {}
      destroy() { release(); }
      async *[Symbol.asyncIterator]() {
        if (options.wait) {
          await gate;
          throw Object.assign(new Error('terminated'), { code: '57P01' });
        }
        for (const row of rows) yield row;
      }
    }
    class Client extends EventEmitter {
      processID = 123;
      connection = { stream: { destroy: () => {} } };
      constructor(readonly config: { user: string; application_name: string }) { super(); }
      async connect() {
        if (this.config.user === 'sandbox_player') backends.set(this.config.application_name, { release });
      }
      query(query: string | Stream, values?: string[]) {
        if (query instanceof Stream) {
          dispatched.push(query.text);
          expect(query.config).toMatchObject({ rowMode: 'array', batchSize: 1 });
          if (options.renamedApplication) {
            backends.delete(this.config.application_name);
            backends.set('player-renamed-session', { release });
          }
          return query;
        }
        if (query.startsWith('SELECT backend_start')) return Promise.resolve({ rows: [{ backend_start: '2026-11-02 12:00:00+00' }] });
        if (this.config.user !== 'sandbox_owner') return Promise.resolve({ rows: [] });
        const key = query.includes('backend_start=$4')
          ? options.renamedApplication ? 'player-renamed-session' : `sandbox-query:${request.executionToken}`
          : values![2];
        const backend = backends.get(key);
        if (query.includes('pg_terminate_backend') && !options.unkillable) {
          backends.delete(key);
          backend?.release();
        }
        return Promise.resolve({ rows: backend ? [{ pid: 123 }] : [] });
      }
      async end() {
        if (this.config.user === 'sandbox_player') backends.delete(this.config.application_name);
      }
    }
    const api = new Function(
      'process', 'Buffer', 'readFile', 'mkdir', 'readdir', 'writeFile', 'rename', 'pg', 'QueryStream', 'createHash',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      `${declarations}\nreturn { runQuery, tokenStatus, confirmStopped };`,
    )(
      {
        argv: [], pid: 42, kill: () => {},
        on: (signal: string, handler: () => void) => signals.set(signal, handler),
        removeListener: (signal: string) => signals.delete(signal),
      }, Buffer,
      async (path: string) => { if (!files.has(path)) throw enoent(); return files.get(path); },
      async (path: string, config: { recursive?: boolean }) => {
        if (directories.has(path) && !config?.recursive) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        directories.add(path);
      },
      async (path: string) => {
        if (!directories.has(path)) throw enoent();
        return [...directories].filter(entry => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/'));
      },
      async (path: string, value: string) => { files.set(path, value); },
      async (before: string, after: string) => { files.set(after, files.get(before)!); files.delete(before); },
      { Client }, Stream, createHash, setTimeout, clearTimeout, setInterval, clearInterval,
    ) as {
      runQuery(value: unknown): Promise<ExecResult>;
      tokenStatus(value: unknown, cancel?: boolean): Promise<{ quiesced: boolean }>;
      confirmStopped(token: string, terminate?: boolean): Promise<void>;
    };
    return { ...api, files, directories, backends, dispatched, signals };
  }

  describe('helper consumed tokens and quiescence', () => {
    it('admits a new query beyond 128 consumed tokens without evicting identities', async () => {
      const helper = queryHarness();
      helper.directories.add('/tmp/sql-executions');
      for (let index = 0; index < 129; index++) {
        helper.directories.add(`/tmp/sql-executions/consumed-${index}`);
      }
      expect(await helper.runQuery(request)).toMatchObject({ exitCode: 0 });
      expect(helper.dispatched).toEqual(['SELECT 1']);
      expect(helper.directories.size).toBe(131);
      expect(helper.directories.has('/tmp/sql-executions/consumed-0')).toBe(true);
      await expect(helper.runQuery(request)).rejects.toThrow('executionConsumed');
    });
    it('executes a token only once even for repeated and concurrent requests', async () => {
      const helper = queryHarness();
      const first = helper.runQuery(request);
      await expect(helper.runQuery(request)).rejects.toThrow('executionConsumed');
      expect(await first).toMatchObject({ stdout: 'duplicate\nhello\n', exitCode: 0 });
      await expect(helper.runQuery(request)).rejects.toThrow('executionConsumed');
      expect(helper.dispatched).toEqual(['SELECT 1']);
      expect((await helper.tokenStatus(request)).quiesced).toBe(true);
      expect([...helper.files.values()].some(value => value.includes('hello'))).toBe(false);
    });
    it('atomically fences an unknown token before reporting quiescence', async () => {
      const helper = queryHarness();
      expect((await helper.tokenStatus(request)).quiesced).toBe(true);
      expect((await helper.tokenStatus(request)).quiesced).toBe(true);
      await expect(helper.runQuery(request)).rejects.toThrow('executionConsumed');
      expect(helper.dispatched).toEqual([]);
    });
    it('truncates before an oversized row and stops its exact backend', async () => {
      const helper = queryHarness([['complete'], ['λ'.repeat(40000)], ['must not appear']]);
      const result = await helper.runQuery(request);
      expect(result).toMatchObject({ stdout: 'duplicate\ncomplete\n', exitCode: null, truncated: true });
      expect(decodeSqlRows(result.stdout)).toEqual([['complete']]);
      expect(helper.backends.size).toBe(0);
      expect((await helper.tokenStatus(request)).quiesced).toBe(true);
    });
    it('stops work after five seconds even with no exec stream or caller cancellation', async () => {
      jest.useFakeTimers();
      try {
        const helper = queryHarness([], { wait: true });
        const pending = helper.runQuery(request);
        await jest.advanceTimersByTimeAsync(1);
        expect(helper.dispatched).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(5000);
        expect(await pending).toMatchObject({ exitCode: null, timedOut: true });
        expect(helper.backends.size).toBe(0);
      } finally { jest.useRealTimers(); }
    });
    it('still cancels a player that changes its application name', async () => {
      jest.useFakeTimers();
      try {
        const helper = queryHarness([], { wait: true, renamedApplication: true });
        const pending = helper.runQuery(request);
        await jest.advanceTimersByTimeAsync(1);
        expect(helper.backends.has('player-renamed-session')).toBe(true);
        await jest.advanceTimersByTimeAsync(5000);
        expect(await pending).toMatchObject({ exitCode: null, timedOut: true });
        expect(helper.backends.size).toBe(0);
      } finally { jest.useRealTimers(); }
    });
    it('cancels the backend on an exec hangup rather than leaving SQL running', async () => {
      jest.useFakeTimers();
      try {
        const helper = queryHarness([], { wait: true });
        const pending = helper.runQuery(request);
        await jest.advanceTimersByTimeAsync(1);
        helper.signals.get('SIGHUP')!();
        expect(await pending).toMatchObject({ exitCode: null, timedOut: false });
        expect(helper.backends.size).toBe(0);
      } finally { jest.useRealTimers(); }
    });
    it('rejects infrastructure failure instead of acknowledging an unkillable backend', async () => {
      jest.useFakeTimers();
      try {
        const helper = queryHarness([], { unkillable: true });
        helper.backends.set(`sandbox-query:${request.executionToken}`, { release: () => {} });
        const pending = expect(helper.confirmStopped(request.executionToken, true)).rejects.toThrow('runtimeUnavailable');
        await jest.advanceTimersByTimeAsync(800);
        await pending;
        expect(helper.backends.size).toBe(1);
      } finally { jest.useRealTimers(); }
    });
    it('does not acknowledge cancellation as quiescent while its helper can still dispatch', async () => {
      const helper = queryHarness();
      const path = `/tmp/sql-executions/${request.executionToken}`;
      helper.directories.add('/tmp/sql-executions');
      helper.directories.add(path);
      helper.files.set(`${path}/owner`, JSON.stringify({ pid: 42 }));
      expect((await helper.tokenStatus(request, true)).quiesced).toBe(false);
    });
    it('never terminates another token', async () => {
      const helper = queryHarness();
      helper.backends.set('sandbox-query:unrelated', { release: () => {} });
      expect((await helper.tokenStatus(request, true)).quiesced).toBe(true);
      expect(helper.backends.has('sandbox-query:unrelated')).toBe(true);
    });
  });
  test.each([65535, 65536, 65537])('only appends complete rows at %i bytes', bytes => {
    const { appendRecord } = helperFunctions();
    const result = { stdout: 'x\n', stderr: 'λ', truncated: false };
    const before = result.stdout;
    const accepted = appendRecord(result, ['a'.repeat(bytes - 5)]);
    expect(accepted).toBe(bytes <= 65536);
    expect(result.truncated).toBe(bytes > 65536);
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(bytes <= 65536 ? bytes : 4);
    if (!accepted) expect(result.stdout).toBe(before);
  });
  it('rejects invalid protocol identities and SQL before opening a database connection', () => {
    const { validateQueryRequest, validateTokenRequest } = helperFunctions();
    const valid = {
      version: 1, executionToken: '9a1d3ee2-9865-48c6-b2f6-8fd1ea0f48b7',
      commandId: '5c6e574b-bb17-4ca2-95e3-e113773afdd9', command: 'SELECT 1',
    };
    expect(() => validateQueryRequest(valid)).not.toThrow();
    expect(() => validateTokenRequest(valid)).not.toThrow();
    for (const override of [
      { version: 2 }, { executionToken: '../escape' }, { commandId: null },
      { command: '' }, { command: 'a'.repeat(4097) },
    ]) expect(() => validateQueryRequest({ ...valid, ...override })).toThrow();
  });
});
