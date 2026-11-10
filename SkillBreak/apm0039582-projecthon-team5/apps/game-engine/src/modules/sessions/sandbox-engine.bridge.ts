import { Inject, Injectable, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';
import { SandboxRepository } from '../sandbox/sandbox.repository';
import { SandboxWorker } from '../sandbox/sandbox-worker';
import { ENGINE_RUNTIME_OPTIONS, type EngineRuntimeOptions } from './engine-options';
import { EngineService } from './engine.service';
import { SandboxExecutorService } from '../sandbox/sandbox-executor';

@Injectable()
export class SandboxEngineBridge implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private shutdown?: Promise<void>;
  constructor(private readonly worker: SandboxWorker, private readonly repository: SandboxRepository,
    private readonly executor: SandboxExecutorService,
    private readonly engine: EngineService, @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    @Optional() @Inject(ENGINE_RUNTIME_OPTIONS) private readonly options?: EngineRuntimeOptions) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.sandbox.enabled && !this.options?.executor) {
      await this.worker.start(this.engine, () => this.executor.recover());
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.onModuleDestroy();
  }

  async onModuleDestroy(): Promise<void> {
    this.shutdown ??= this.drain();
    await this.shutdown;
  }

  private async drain(): Promise<void> {
    await this.executor.stop();
    await this.worker.stop();
    await this.repository.close();
  }
}
