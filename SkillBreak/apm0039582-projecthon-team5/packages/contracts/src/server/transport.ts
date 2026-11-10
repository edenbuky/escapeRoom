import type { GameEvent } from '../messages/game-events';
import type { PlayerCommand } from '../messages/player-commands';

export interface StreamMessages {
  'player-commands': PlayerCommand;
  'game-events': GameEvent;
}
export interface MessageProducer {
  /** Acceptance by the transport, not business commit. Retries retain message identity. */
  publish<S extends keyof StreamMessages>(stream: S, message: StreamMessages[S]): Promise<void>;
}
export interface Subscription {
  /** Stop new dispatches and drain in-flight handlers; failures remain observable. */
  close(): Promise<void>;
}
export interface MessageConsumer {
  /** Serialize each session, preserve sibling-event order, and observe handler rejection. */
  subscribe<S extends keyof StreamMessages>(
    stream: S,
    consumer: string,
    handler: (message: StreamMessages[S]) => Promise<void>,
  ): Promise<Subscription>;
}
