import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SessionOwnerClient } from './session-owner.client';
import { SessionsService, UnavailableSessionPublisher } from './sessions.service';

describe('canonical gateway session commands', () => {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const publish = jest.fn();
  const owners = new SessionOwnerClient('', '');
  const service = new SessionsService({ publish }, owners);
  beforeEach(() => {
    publish.mockReset().mockResolvedValue(undefined);
    jest.spyOn(owners, 'getOwner').mockResolvedValue({ ownerId: userId });
  });
  afterEach(() => jest.restoreAllMocks());

  it('publishes canonical start commands with stable case-normalized identities', async () => {
    const requestId = randomUUID();
    const first = await service.start(userId, 'escape-room', requestId);
    expect(await service.start(userId, 'escape-room', requestId.toUpperCase())).toEqual(first);
    expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
    expect(publish.mock.calls[0]).toEqual(['player-commands', {
      type: 'StartSession', sessionId: first.sessionId, messageId: expect.any(String),
      payload: { userId, scriptSlug: 'escape-room' },
    }]);
  });
  it('logs the start line by sessionId and scriptSlug only, after the publish', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const requestId = randomUUID();
    const { sessionId: started } = await service.start(userId, 'escape-room', requestId);
    expect(log.mock.calls).toEqual([[`Start game requested sessionId=${started} scriptSlug=escape-room`]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(userId);
    expect(JSON.stringify(log.mock.calls)).not.toContain(requestId);
    log.mockClear();
    publish.mockRejectedValue(new Error('private transport credentials'));
    await expect(service.start(userId, 'escape-room', randomUUID())).rejects.toThrow('Game transport unavailable');
    expect(log).not.toHaveBeenCalled();
  });
  it('keeps submit and abandon identities stable across retries', async () => {
    const commandId = randomUUID();
    for (const id of [sessionId, sessionId.toUpperCase()]) {
      await service.submit(userId, id, 'idan-db', commandId, { kind: 'command', command: 'SELECT 1' });
      await service.abandon(userId, id);
    }
    expect(publish.mock.calls[0]).toEqual(publish.mock.calls[2]);
    expect(publish.mock.calls[1]).toEqual(publish.mock.calls[3]);
    expect(publish.mock.calls[0][1].payload).toEqual({ userId, puzzleKey: 'idan-db',
      input: { kind: 'command', command: 'SELECT 1' } });
  });
  it('does not publish for non-owners', async () => {
    jest.spyOn(owners, 'getOwner').mockResolvedValue({ ownerId: randomUUID() });
    await expect(service.abandon(userId, sessionId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.submit(userId, sessionId, 'idan-db', randomUUID(), { kind: 'answer', answer: 'x' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(publish).not.toHaveBeenCalled();
  });
  it.each([new NotFoundException(), new ServiceUnavailableException()])('preserves owner lookup errors', async error => {
    jest.spyOn(owners, 'getOwner').mockRejectedValue(error);
    await expect(service.abandon(userId, sessionId)).rejects.toBe(error);
    expect(publish).not.toHaveBeenCalled();
  });
  it('fails closed without a publisher and sanitizes publisher errors', async () => {
    await expect(new SessionsService(new UnavailableSessionPublisher(), owners).start(userId, 'escape-room', randomUUID()))
      .rejects.toThrow('Game transport unavailable');
    publish.mockRejectedValue(new Error('private transport credentials'));
    await expect(service.abandon(userId, sessionId)).rejects.toThrow('Game transport unavailable');
  });
  it('logs the publish failure name and code, never the message', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    publish.mockRejectedValue(Object.assign(new Error('private transport credentials'), { code: 'ETIMEDOUT' }));
    await expect(service.abandon(userId, sessionId)).rejects.toThrow('Game transport unavailable');
    expect(warn).toHaveBeenCalledWith('Game transport publish failed: Error code=ETIMEDOUT');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });
});

describe('engine owner client boundary', () => {
  const sessionId = randomUUID();
  afterEach(() => jest.restoreAllMocks());

  it('uses the internal token, bounded deadline, no redirects and the merged owner-only shape', async () => {
    const ownerId = randomUUID();
    const fetchOwner = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ownerId })));
    expect(await new SessionOwnerClient('http://engine:3001', 'internal').getOwner(sessionId)).toEqual({ ownerId });
    expect(fetchOwner).toHaveBeenCalledWith(`http://engine:3001/internal/sessions/${sessionId}/owner`, {
      headers: { 'x-internal-token': 'internal' }, signal: expect.any(AbortSignal), redirect: 'error',
    });
  });
  it.each([null, {}, { ownerId: 1 }, { ownerId: 'not-a-uuid' }])('rejects malformed owner response %#', async body => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(new SessionOwnerClient('http://engine', 'internal').getOwner(sessionId)).rejects.toThrow('Session service unavailable');
  });
  it.each([401, 403, 500, 503])('sanitizes owner HTTP %s', async status => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private failure', { status }));
    await expect(new SessionOwnerClient('http://engine', 'internal').getOwner(sessionId)).rejects.toThrow('Session service unavailable');
  });
  it('preserves 404 and sanitizes network timeouts', async () => {
    const fetchOwner = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockRejectedValueOnce(new DOMException('private URL', 'TimeoutError'));
    const client = new SessionOwnerClient('http://engine', 'internal');
    await expect(client.getOwner(sessionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(client.getOwner(sessionId)).rejects.toThrow('Session service unavailable');
    expect(fetchOwner).toHaveBeenCalledTimes(2);
  });
  it('logs the owner lookup failure name, never the URL or message', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('private URL', 'TimeoutError'));
    await expect(new SessionOwnerClient('http://engine', 'internal').getOwner(sessionId)).rejects.toThrow('Session service unavailable');
    expect(warn).toHaveBeenCalledWith('Session owner lookup failed: TimeoutError code=23');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });
  it('does not contact the engine without an internal token', async () => {
    const fetchOwner = jest.spyOn(globalThis, 'fetch');
    await expect(new SessionOwnerClient('http://engine', '').getOwner(sessionId)).rejects.toThrow('Session service unavailable');
    expect(fetchOwner).not.toHaveBeenCalled();
  });
});