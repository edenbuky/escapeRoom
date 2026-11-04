import type {
  MessageConsumer,
  MessageProducer,
  StreamMessages,
  Subscription,
} from '@team5/contracts/server';

type StreamName = keyof StreamMessages;
type AnyMessage = StreamMessages[StreamName];

interface ConsumerSubscription {
  stream: StreamName;
  consumer: string;
  dispatch(message: AnyMessage): Promise<void>;
  sessionTails: Map<string, Promise<void>>;
  errors: unknown[];
  closing: boolean;
  closePromise?: Promise<void>;
}

export class InMemoryTransport implements MessageProducer, MessageConsumer {
  private readonly subscriptions = new Map<StreamName, Set<ConsumerSubscription>>();

  async publish<S extends StreamName>(stream: S, message: StreamMessages[S]): Promise<void> {
    this.enqueue(stream, message);
  }

  async redeliver<S extends StreamName>(stream: S, message: StreamMessages[S]): Promise<void> {
    this.enqueue(stream, message);
  }

  async subscribe<S extends StreamName>(
    stream: S,
    consumer: string,
    handler: (message: StreamMessages[S]) => Promise<void>,
  ): Promise<Subscription> {
    const subscription: ConsumerSubscription = {
      stream,
      consumer,
      dispatch: (message) => handler(message as StreamMessages[S]),
      sessionTails: new Map(),
      errors: [],
      closing: false,
    };
    const streamSubscriptions = this.subscriptions.get(stream) ?? new Set();
    streamSubscriptions.add(subscription);
    this.subscriptions.set(stream, streamSubscriptions);

    return {
      close: () => this.close(subscription),
    };
  }

  private enqueue<S extends StreamName>(stream: S, message: StreamMessages[S]): void {
    for (const subscription of this.subscriptions.get(stream) ?? []) {
      if (!subscription.closing) {
        this.enqueueForSubscription(subscription, message);
      }
    }
  }

  private enqueueForSubscription(subscription: ConsumerSubscription, message: AnyMessage): void {
    const previous = subscription.sessionTails.get(message.sessionId) ?? Promise.resolve();
    const tail = previous
      .then(() => subscription.dispatch(message))
      .catch((error: unknown) => {
        subscription.errors.push(error);
      });
    subscription.sessionTails.set(message.sessionId, tail);
    void tail.then(() => {
      if (subscription.sessionTails.get(message.sessionId) === tail) {
        subscription.sessionTails.delete(message.sessionId);
      }
    });
  }

  private close(subscription: ConsumerSubscription): Promise<void> {
    if (subscription.closePromise) {
      return subscription.closePromise;
    }

    subscription.closing = true;
    const streamSubscriptions = this.subscriptions.get(subscription.stream);
    streamSubscriptions?.delete(subscription);
    if (streamSubscriptions?.size === 0) {
      this.subscriptions.delete(subscription.stream);
    }

    subscription.closePromise = Promise.all([...subscription.sessionTails.values()]).then(() => {
      if (subscription.errors.length === 1) {
        throw subscription.errors[0];
      }
      if (subscription.errors.length > 1) {
        throw new AggregateError(subscription.errors, 'Multiple message handlers failed');
      }
    });
    return subscription.closePromise;
  }
}
