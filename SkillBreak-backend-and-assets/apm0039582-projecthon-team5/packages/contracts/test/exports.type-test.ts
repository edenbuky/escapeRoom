import type { SessionView, GameEvent, Verdict } from '@team5/contracts';
type Assert<T extends true> = T;
type NoSecrets = Assert<Extract<keyof SessionView, 'solutionRef' | 'ownerId' | 'expectedAnswer' | 'input'> extends never ? true : false>;
// @ts-expect-error browser environment has no Node global
const node = process;
// @ts-expect-error no private deep-import export
import type { EventEnvelope } from '@team5/contracts/dist/messages/envelope';
// @ts-expect-error engine-only sandbox interfaces are not browser exports
import type { SandboxOutcomeSink } from '@team5/contracts';
export type BrowserConsumer = { view: SessionView; event: GameEvent; verdict: Verdict };
void node;
