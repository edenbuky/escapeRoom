import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { Subscription } from '@team5/contracts/server';
import { describeFailure, OutboxRelay } from '@team5/messaging';
import { DataSource } from 'typeorm';
import { ENGINE_RUNTIME_OPTIONS, type EngineRuntimeOptions } from './engine-options';
import { EngineService } from './engine.service';

@Injectable()
export class EngineRuntime implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EngineRuntime.name);
  private subscription?: Subscription;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<number>;
  private closing = false;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private expiring?: Promise<void>;
  constructor(private readonly database: DataSource, private readonly engine: EngineService,
    @Optional() @Inject(ENGINE_RUNTIME_OPTIONS) private readonly options: EngineRuntimeOptions = {}) {}

  async onModuleInit(): Promise<void> {
    if (this.options.consumer) {
      if (!this.options.producer) throw new Error('Engine consumer requires a game-events producer');
      this.subscription = await this.options.consumer.subscribe('player-commands', 'engine', message => this.engine.handle(message));
    }
  }
  onApplicationBootstrap(): void {
    const expire = () => {
      if (this.expiring || this.closing) return;
      this.expiring = this.engine.expireDue().catch(error => this.logger.warn(`Expiry retry required: ${describeFailure(error)}`))
        .finally(() => { this.expiring = undefined; });
    };
    expire();
    this.expiryTimer = setInterval(expire, 1000);
    this.expiryTimer.unref();
    if (this.options.producer) {
      this.timer = setInterval(() => {
        void this.flush().catch(error => this.logger.warn(`Engine outbox delivery failed; pending events retained: ${describeFailure(error)}`));
      }, 100);
      this.timer.unref();
    }
  }
  get connected(): boolean { return !!this.subscription; }

  async flush(): Promise<number> {
    if (!this.options.producer || this.closing) return 0;
    if (this.pending) return this.pending;
    const producer = this.options.producer;
    this.pending = this.database.transaction(async manager => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('team5-engine-outbox-relay', 0))");
      return new OutboxRelay(this.database, producer).relayPending();
    });
    try {
      const relayed = await this.pending;
      if (relayed) this.logger.log(`Relayed ${relayed} game events`);
      return relayed;
    } finally { this.pending = undefined; }
  }
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    await this.expiring;
    await this.subscription?.close();
    await this.pending;
  }
}