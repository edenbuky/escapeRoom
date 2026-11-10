import type { MessageConsumer, MessageProducer } from '@team5/contracts/server';
import type { SandboxExecutor } from '../sandbox/sandbox.contracts';

export const ENGINE_RUNTIME_OPTIONS = Symbol('ENGINE_RUNTIME_OPTIONS');
export interface EngineRuntimeOptions {
  producer?: MessageProducer;
  consumer?: MessageConsumer;
  executor?: SandboxExecutor;
}