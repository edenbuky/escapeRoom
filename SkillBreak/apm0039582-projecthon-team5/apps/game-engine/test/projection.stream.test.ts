import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { SessionStreamService, SnapshotWriter, validateCursor } from '../src/modules/projection/session-stream.service';
import { publicView } from '../src/modules/projection/projection.reducer';
import { fixtureView, ProjectionHarness, until } from './helpers/projection-harness';
import { ProjectionDatabase } from '../src/modules/projection/projection-database';
import { ProjectionRepository, type ProjectionRecord } from '../src/modules/projection/projection.repository';
import { ProjectionListener } from '../src/modules/projection/projection.listener';

class Sink extends EventEmitter {
  write = jest.fn((_chunk: string) => true);
  end = jest.fn(() => { this.emit('close'); });
  destroy = jest.fn(() => { this.emit('close'); });
  setHeader = jest.fn();
  flushHeaders = jest.fn();
}
afterEach(() => jest.useRealTimers());
test('writes full JSON frames and heartbeat comments, then closes at strict expiry', () => {
  jest.useFakeTimers();
  const sink = new Sink();
  const closed = jest.fn();
  const writer = new SnapshotWriter(sink, Date.now() + 20000, closed);
  writer.send(publicView(fixtureView()));
  expect(sink.write.mock.calls[0][0]).toContain('event: session\nid: 1\ndata: ');
  jest.advanceTimersByTime(15000);
  expect(sink.write).toHaveBeenLastCalledWith(': heartbeat\n\n');
  jest.advanceTimersByTime(5000);
  expect(sink.end).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('registers before read, delivers initial first, and refreshes equal versions by lossless private revision', async () => {
  const config = new ProjectionHarness().config;
  const repository = new ProjectionRepository(new ProjectionDatabase(config));
  const listener = new ProjectionListener(config);
  listener.ready = true;
  const service = new SessionStreamService(repository, listener);
  const view = fixtureView();
  const first: ProjectionRecord = { ownerId: view.sessionId, version: 1, revision: '9007199254740993', view };
  const next = { ...first, revision: '9007199254740994', view: { ...view, currentRoom: { ...view.currentRoom, files: [{ name: 'clue', content: 'next' }] } } };
  let release!: (record: ProjectionRecord) => void;
  const read = jest.spyOn(repository, 'read').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue(next);
  const sink = new Sink();
  try {
    const opening = service.open(view.sessionId, { subject: first.ownerId, expiresAt: Date.now() + 60000 }, sink);
    for (const change of listener.changes) change(view.sessionId);
    release(first);
    await opening;
    await until(() => sink.write.mock.calls.length === 2);
    expect(sink.write.mock.calls[0][0]).not.toContain('next');
    expect(sink.write.mock.calls[1][0]).toContain('next');
    expect(sink.write.mock.calls.every(([frame]) => frame.includes('id: 1'))).toBe(true);
    read.mockResolvedValue(first);
    for (const change of listener.changes) change(view.sessionId);
    await until(() => read.mock.calls.length === 3);
    await new Promise(resolve => setImmediate(resolve));
    expect(sink.write).toHaveBeenCalledTimes(2);
  } finally { service.onModuleDestroy(); }
  expect(listener.changes.size).toBe(0);
  expect(listener.unavailable.size).toBe(0);
});
test('retains only latest pending state and closes on drain timeout or cancellation', () => {
  jest.useFakeTimers();
  const sink = new Sink();
  sink.write.mockReturnValue(false);
  const writer = new SnapshotWriter(sink, Date.now() + 60000, jest.fn());
  const view = publicView(fixtureView());
  writer.send(view);
  writer.send({ ...view, version: 2 });
  writer.send({ ...view, version: 3 });
  expect(sink.write).toHaveBeenCalledTimes(1);
  sink.write.mockReturnValue(true);
  sink.emit('drain');
  expect(sink.write.mock.calls[1][0]).toContain('id: 3');
  sink.write.mockReturnValue(false);
  writer.send(view);
  jest.advanceTimersByTime(15000);
  expect(sink.destroy).toHaveBeenCalledTimes(1);
  expect(sink.end).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
test('cursor is validated, not used as a suppression filter', () => {
  for (const cursor of [undefined, '1', '9999']) expect(() => validateCursor(cursor)).not.toThrow();
  for (const cursor of ['', '-1', '1.1', 'NaN', '9007199254740992']) expect(() => validateCursor(cursor)).toThrow();
});

test.each(['disconnect', 'denied', 'shutdown'] as const)('cleans provisional readers on %s without sending data', async reason => {
  const config = new ProjectionHarness().config;
  const repository = new ProjectionRepository(new ProjectionDatabase(config));
  const listener = new ProjectionListener(config);
  listener.ready = true;
  const service = new SessionStreamService(repository, listener);
  const view = fixtureView();
  let release!: (record: ProjectionRecord) => void;
  const read = jest.spyOn(repository, 'read').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const sink = new Sink();
  try {
    const opening = service.open(view.sessionId, { subject: 'owner', expiresAt: Date.now() + 60000 }, sink);
    if (reason === 'disconnect') sink.emit('close');
    if (reason === 'shutdown') service.onModuleDestroy();
    release({ ownerId: reason === 'denied' ? 'other' : 'owner', version: 1, revision: '1', view });
    if (reason === 'denied') await expect(opening).rejects.toThrow();
    else await opening;
    for (const change of listener.changes) change(view.sessionId);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sink.write).not.toHaveBeenCalled();
    expect(sink.listenerCount('close')).toBe(0);
  } finally { service.onModuleDestroy(); }
});

test('expiry wins over backpressure and no writes or timers survive close', () => {
  jest.useFakeTimers();
  const sink = new Sink();
  sink.write.mockReturnValue(false);
  const closed = jest.fn();
  const writer = new SnapshotWriter(sink, Date.now() + 100, closed);
  writer.send(publicView(fixtureView()));
  writer.send(publicView(fixtureView()));
  jest.advanceTimersByTime(100);
  sink.emit('drain');
  writer.close();
  writer.send(publicView(fixtureView()));
  jest.advanceTimersByTime(60000);
  expect(sink.write).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test.each(['listener', 'database'] as const)('%s loss closes streams and releases per-session state', async failure => {
  const config = new ProjectionHarness().config;
  const repository = new ProjectionRepository(new ProjectionDatabase(config));
  const listener = new ProjectionListener(config);
  listener.ready = true;
  const service = new SessionStreamService(repository, listener);
  const view = fixtureView();
  const read = jest.spyOn(repository, 'read').mockResolvedValue({ ownerId: 'owner', version: 1, revision: '1', view });
  const sink = new Sink();
  try {
    await service.open(view.sessionId, { subject: 'owner', expiresAt: Date.now() + 60000 }, sink);
    if (failure === 'listener') for (const close of listener.unavailable) close();
    else {
      read.mockRejectedValue(new Error('private database details'));
      for (const change of listener.changes) change(view.sessionId);
    }
    await until(() => sink.end.mock.calls.length === 1);
    const count = read.mock.calls.length;
    for (const change of listener.changes) change(view.sessionId);
    await new Promise(resolve => setImmediate(resolve));
    expect(read).toHaveBeenCalledTimes(count);
    expect(sink.listenerCount('drain')).toBe(0);
  } finally { service.onModuleDestroy(); }
});

test('shares serialized reads while a slow client coalesces independently from a fast client', async () => {
  const config = new ProjectionHarness().config;
  const repository = new ProjectionRepository(new ProjectionDatabase(config));
  const listener = new ProjectionListener(config);
  listener.ready = true;
  const service = new SessionStreamService(repository, listener);
  const view = fixtureView();
  const record = { ownerId: 'owner', version: 1, revision: '1', view };
  const read = jest.spyOn(repository, 'read').mockResolvedValue(record);
  const slow = new Sink(), fast = new Sink();
  slow.write.mockReturnValue(false);
  const claims = { subject: 'owner', expiresAt: Date.now() + 60000 };
  try {
    await Promise.all([service.open(view.sessionId, claims, slow), service.open(view.sessionId, claims, fast)]);
    expect(read).toHaveBeenCalledTimes(1);
    let release!: (value: ProjectionRecord) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    for (const change of listener.changes) change(view.sessionId);
    for (const change of listener.changes) change(view.sessionId);
    expect(read).toHaveBeenCalledTimes(2);
    const second = { ...record, revision: '2', view: { ...view, latestResult: {
      commandId: view.sessionId, verdict: 'progress' as const, reason: null, output: 'second',
    } } };
    const third = { ...second, revision: '3', view: { ...second.view, latestResult: { ...second.view.latestResult, output: 'third' } } };
    read.mockResolvedValue(third);
    release(second);
    await until(() => fast.write.mock.calls.length === 3);
    expect(read).toHaveBeenCalledTimes(3);
    expect(slow.write).toHaveBeenCalledTimes(1);
    slow.write.mockReturnValue(true);
    slow.emit('drain');
    expect(slow.write).toHaveBeenCalledTimes(2);
    expect(slow.write.mock.calls[1][0]).toContain('third');
  } finally { service.onModuleDestroy(); }
});

test('refresh and post-header failures are logged by name and code, never the message', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const config = new ProjectionHarness().config;
  const repository = new ProjectionRepository(new ProjectionDatabase(config));
  const listener = new ProjectionListener(config);
  listener.ready = true;
  const service = new SessionStreamService(repository, listener);
  const view = fixtureView();
  const read = jest.spyOn(repository, 'read').mockResolvedValue({ ownerId: 'owner', version: 1, revision: '1', view });
  const claims = { subject: 'owner', expiresAt: Date.now() + 60000 };
  try {
    const refreshed = new Sink();
    await service.open(view.sessionId, claims, refreshed);
    read.mockRejectedValue(Object.assign(new Error('private database details'), { code: '57014' }));
    for (const change of listener.changes) change(view.sessionId);
    await until(() => refreshed.end.mock.calls.length === 1);
    expect(warn).toHaveBeenCalledWith('Projection refresh failed; closing session streams: Error code=57014');

    read.mockResolvedValue({ ownerId: 'owner', version: 1, revision: '1', view });
    const broken = new Sink();
    broken.flushHeaders.mockImplementation(() => { throw Object.assign(new Error('private socket'), { code: 'EPIPE' }); });
    await service.open(view.sessionId, claims, broken);
    expect(warn).toHaveBeenCalledWith('Session stream setup failed after headers: Error code=EPIPE');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  } finally { service.onModuleDestroy(); warn.mockRestore(); }
});
