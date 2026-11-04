import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConsumerAttempt, DeadLetter, InboxReceipt } from '@team5/messaging';
import { DataSource } from 'typeorm';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';

@Injectable()
export class ProjectionDatabase implements OnModuleInit, OnApplicationShutdown {
  readonly source: DataSource;
  private starting?: Promise<void>;
  constructor(@Inject(ENGINE_CONFIG) config: EngineConfig) {
    this.source = new DataSource({ type: 'postgres', url: config.databaseUrl, schema: 'projection',
      entities: [ConsumerAttempt, DeadLetter, InboxReceipt], synchronize: false,
      extra: { max: 3, options: '-c search_path=projection', connectionTimeoutMillis: 2000,
        query_timeout: 2000, statement_timeout: 2000 } });
  }
  start(): Promise<void> {
    this.starting ??= this.source.initialize().then(() => undefined);
    return this.starting;
  }
  onModuleInit(): Promise<void> { return this.start(); }
  async tablesReady(): Promise<boolean> {
    const rows: { ready: boolean }[] = await this.source.query(`SELECT
      to_regclass('projection.session_view') IS NOT NULL AND
      to_regclass('projection.messaging_inbox_receipt') IS NOT NULL AND
      to_regclass('projection.messaging_consumer_attempt') IS NOT NULL AND
      to_regclass('projection.messaging_dead_letter') IS NOT NULL AS ready`);
    return rows[0]?.ready === true;
  }
  async onApplicationShutdown(): Promise<void> {
    if (this.source.isInitialized) await this.source.destroy();
  }
}
