import type { EventEnvelope, GameEvent, PlayerCommand } from '../src';
import type { MessageProducer, MessageConsumer } from '../src/server';
import { commands, events } from './fixtures';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type EnvelopeKeys = Assert<Equal<keyof EventEnvelope, 'eventId' | 'sessionId' | 'sessionVersion' | 'occurredAt'>>;
type NoRemovedMessages = Assert<Equal<Extract<GameEvent['type'] | PlayerCommand['type'],
  'ProvisionSandbox' | 'DestroySandbox' | 'SandboxReady' | 'SandboxFailed' | 'SandboxDestroyed' | 'ScriptVersionPublished' | 'TemplateVersionPublished'>, never>>;

export function check(producer: MessageProducer, consumer: MessageConsumer): void {
  void producer.publish('player-commands', commands.StartSession);
  void producer.publish('game-events', events.SessionStarted);
  void consumer.subscribe('game-events', 'projection', async event => { const id: string = event.eventId; void id; });
  // @ts-expect-error game events do not belong on player-commands
  void producer.publish('player-commands', events.SessionStarted);
  // @ts-expect-error catalog stream was removed
  void producer.publish('catalog-events', events.SessionStarted);
  // @ts-expect-error required sessionId cannot be omitted
  const missing: PlayerCommand = { type: 'RequestHint', messageId: 'id', payload: { userId: 'player' } };
  // @ts-expect-error an input requires its discriminator-specific data
  const input: PlayerCommand = { ...commands.SubmitInput, payload: { userId: 'player', puzzleKey: 'sql', input: { kind: 'command' } } };
  void missing; void input;
}
