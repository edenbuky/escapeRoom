import type { GameEvent } from '@team5/contracts';
import { InMemoryTransport } from '../src/transport/in-memory-transport';

function sessionEscaped(messageId: string, sessionId = 'session-1'): GameEvent {
  return {
    eventId: messageId,
    messageId,
    sessionId,
    sessionVersion: 1,
    occurredAt: '2026-11-02T00:00:00.000Z',
    type: 'SessionEscaped',
    payload: { endedAt: '2026-11-02T00:00:00.000Z' },
  };
}

describe('InMemoryTransport', () => {
  it('delivers in publication order to each consumer, including same-version sibling events', async () => {
    const transport = new InMemoryTransport();
    const firstConsumer: string[] = [];
    const secondConsumer: string[] = [];
    const first = await transport.subscribe('game-events', 'projection', async (message) => {
      firstConsumer.push(message.messageId);
    });
    const second = await transport.subscribe('game-events', 'analytics', async (message) => {
      secondConsumer.push(message.messageId);
    });

    await transport.publish('game-events', sessionEscaped('event-1'));
    await transport.publish('game-events', sessionEscaped('event-2'));

    await Promise.all([first.close(), second.close()]);

    expect(firstConsumer).toEqual(['event-1', 'event-2']);
    expect(secondConsumer).toEqual(['event-1', 'event-2']);
  });

  it('allows tests to redeliver the same message identity', async () => {
    const transport = new InMemoryTransport();
    const received: string[] = [];
    const subscription = await transport.subscribe('game-events', 'projection', async (message) => {
      received.push(message.messageId);
    });
    const message = sessionEscaped('event-1');

    await transport.publish('game-events', message);
    await transport.redeliver('game-events', message);
    await subscription.close();

    expect(received).toEqual(['event-1', 'event-1']);
  });

  it('dispatches other sessions while one session handler is still running', async () => {
    const transport = new InMemoryTransport();
    let releaseSlowSession!: () => void;
    let markSlowStarted!: () => void;
    let markFastStarted!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlowSession = resolve;
    });
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const fastStarted = new Promise<void>((resolve) => {
      markFastStarted = resolve;
    });
    const subscription = await transport.subscribe('game-events', 'projection', async (message) => {
      if (message.sessionId === 'slow-session') {
        markSlowStarted();
        await slowGate;
      } else {
        markFastStarted();
      }
    });

    await transport.publish('game-events', sessionEscaped('slow-event', 'slow-session'));
    await slowStarted;
    await transport.publish('game-events', sessionEscaped('fast-event', 'fast-session'));
    await fastStarted;

    releaseSlowSession();
    await subscription.close();
  });

  it('stops accepting messages and drains in-flight handlers when closed', async () => {
    const transport = new InMemoryTransport();
    let releaseHandler!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let handled = 0;
    const subscription = await transport.subscribe('game-events', 'projection', async () => {
      handled += 1;
      markStarted();
      await gate;
    });

    await transport.publish('game-events', sessionEscaped('event-1'));
    await started;
    let closed = false;
    const closePromise = subscription.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseHandler();
    await closePromise;
    await transport.publish('game-events', sessionEscaped('event-2'));

    expect(handled).toBe(1);
  });

  it('surfaces handler failures when the subscription closes', async () => {
    const transport = new InMemoryTransport();
    const subscription = await transport.subscribe('game-events', 'projection', async () => {
      throw new Error('handler failed');
    });

    await transport.publish('game-events', sessionEscaped('event-1'));

    await expect(subscription.close()).rejects.toThrow('handler failed');
  });
});
