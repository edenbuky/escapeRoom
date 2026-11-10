import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { Subscription } from '@team5/contracts/server';
import { ENGINE_RUNTIME_OPTIONS, type EngineRuntimeOptions } from '../sessions/engine-options';
import { ProjectionDatabase } from './projection-database';
import { ProjectionConsumer } from './projection.consumer';

@Injectable()
export class ProjectionRuntime implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(ProjectionRuntime.name);
  private subscription?: Subscription;
  constructor(private readonly database: ProjectionDatabase, private readonly consumer: ProjectionConsumer,
    @Optional() @Inject(ENGINE_RUNTIME_OPTIONS) private readonly options: EngineRuntimeOptions = {}) {}
  get connected(): boolean { return !!this.subscription; }
  async onModuleInit(): Promise<void> {
    await this.database.start();
    if (!this.options.consumer) {
      this.logger.warn('Projection transport not_connected');
      return;
    }
    this.subscription = await this.options.consumer.subscribe('game-events', 'projection', message => this.consumer.handle(message));
  }
  async beforeApplicationShutdown(): Promise<void> {
    const subscription = this.subscription;
    this.subscription = undefined;
    await subscription?.close();
  }
}
