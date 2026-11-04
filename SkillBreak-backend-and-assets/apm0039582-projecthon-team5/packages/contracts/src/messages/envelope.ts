/** IDs are nonempty UUIDs; versions are positive safe integers; timestamps are UTC ISO 8601. */
export interface EventEnvelope {
  eventId: string;
  sessionId: string;
  sessionVersion: number;
  occurredAt: string;
}

export type Command<T extends string, P> = {
  messageId: string;
  sessionId: string;
  type: T;
  payload: P;
};

/** messageId equals eventId; distinct events may share a transition's sessionVersion. */
export type EventMessage<T extends string, P> = EventEnvelope & {
  messageId: string;
  type: T;
  payload: P;
};
