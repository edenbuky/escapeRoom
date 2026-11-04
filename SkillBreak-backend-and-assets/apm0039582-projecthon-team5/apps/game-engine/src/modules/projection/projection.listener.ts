import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { describeFailure } from '@team5/messaging';
import { Client } from 'pg';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';
import { uuid } from './projection.reducer';

@Injectable()
export class ProjectionListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectionListener.name);
  private client?: Client;
  private connecting?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private delay = 100;
  readonly changes = new Set<(sessionId: string) => void>();
  readonly unavailable = new Set<() => void>();
  ready = false;
  backendPid?: number;
  constructor(@Inject(ENGINE_CONFIG) private readonly config: EngineConfig) {}
  onModuleInit(): Promise<void> { return this.connect(); }
  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.config.databaseUrl, connectionTimeoutMillis: 2000, query_timeout: 2000 });
    this.client = client;
    client.on('error', () => this.failed(client));
    client.on('end', () => this.failed(client));
    client.on('notification', notification => {
      if (!this.ready || notification.channel !== 'session_projection_changed') return;
      let sessionId: string;
      try { sessionId = uuid(notification.payload); }
      catch { this.logger.warn('Invalid projection notification identity'); return; }
      for (const change of this.changes) change(sessionId);
    });
    try {
      await client.connect();
      const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await client.query('LISTEN session_projection_changed');
      if (this.stopped || this.client !== client) { await client.end(); return; }
      this.backendPid = result.rows[0].pid;
      this.ready = true;
      this.delay = 100;
    } catch (error) {
      this.failed(client);
      throw error;
    }
  }
  private failed(client: Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.ready = false;
    this.backendPid = undefined;
    for (const close of [...this.unavailable]) close();
    void client.end().catch(error => this.logger.warn(`Projection listener cleanup failed: ${describeFailure(error)}`));
    if (this.stopped) return;
    this.logger.warn('Projection listener unavailable; streams closed');
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect().catch(error => {
        this.logger.warn(`Projection listener reconnect failed: ${describeFailure(error)}`);
        this.schedule();
      });
    }, this.delay);
    this.timer.unref();
    this.delay = Math.min(this.delay * 2, 5000);
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.backendPid = undefined;
    if (this.timer) clearTimeout(this.timer);
    for (const close of [...this.unavailable]) close();
    this.changes.clear();
    this.unavailable.clear();
    const client = this.client;
    this.client = undefined;
    if (client) await client.end();
    try { await this.connecting; }
    catch { this.logger.warn('Projection listener connection interrupted during shutdown'); }
  }
}
