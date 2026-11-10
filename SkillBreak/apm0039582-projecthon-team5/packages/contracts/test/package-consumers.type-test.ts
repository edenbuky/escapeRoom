import type { GameEvent, PlayerCommand, SessionView } from '@team5/contracts';
import type { MessageProducer, MessageConsumer } from '@team5/contracts/server';

export async function consume(producer: MessageProducer, consumer: MessageConsumer, command: PlayerCommand, event: GameEvent): Promise<void> {
  await producer.publish('player-commands', command);
  await producer.publish('game-events', event);
  const subscription = await consumer.subscribe('game-events', 'projection', async message => {
    const version: SessionView['version'] = message.sessionVersion;
    void version;
  });
  await subscription.close();
}
// @ts-expect-error transport is restricted to the server subpath
import type { MessageProducer as BrowserProducer } from '@team5/contracts';
