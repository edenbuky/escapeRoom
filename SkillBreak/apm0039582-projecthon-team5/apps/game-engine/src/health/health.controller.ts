import { Controller, Get, Inject, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EngineRuntime } from '../modules/sessions/engine-runtime';
import { ENGINE_CONFIG, type EngineConfig } from '../config/config';
import { SandboxWorker } from '../modules/sandbox/sandbox-worker';
import { ProjectionDatabase } from '../modules/projection/projection-database';
import { ProjectionListener } from '../modules/projection/projection.listener';
import { ProjectionRuntime } from '../modules/projection/projection.runtime';

async function bounded<T>(probe: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([probe, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Health probe timeout')), 2000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  constructor(private readonly db: DataSource,
    @Optional() private readonly runtime?: EngineRuntime,
    @Optional() private readonly sandbox?: SandboxWorker,
    @Optional() @Inject(ENGINE_CONFIG) private readonly config?: EngineConfig,
    @Optional() private readonly projectionDatabase?: ProjectionDatabase,
    @Optional() private readonly projectionListener?: ProjectionListener,
    @Optional() private readonly projectionRuntime?: ProjectionRuntime) {}

  @Get()
  async check() {
    const workerState = this.sandbox?.status ?? 'disabled';
    const [database, runtime, projection] = await Promise.allSettled([
      bounded(this.db.query<{ catalog: boolean; projection: boolean; sandbox: boolean }[]>(
        `SELECT to_regclass('team5.scripts') IS NOT NULL AND
            to_regclass('team5.script_versions') IS NOT NULL AND
            to_regclass('team5.component_templates') IS NOT NULL AS catalog,
          to_regclass('team5.session_view') IS NOT NULL AS projection,
          to_regclass('team5.sandbox_instances') IS NOT NULL AND to_regclass('team5.sandbox_executions') IS NOT NULL
            AND to_regclass('team5.sandbox_outcomes') IS NOT NULL AS sandbox`,
      )),
      workerState === 'disabled' ? Promise.resolve(true) : bounded(this.sandbox!.checkRuntime()),
      this.projectionDatabase ? bounded(this.projectionDatabase.tablesReady()) : Promise.resolve(false),
    ]);
    const schemas = database.status === 'fulfilled' ? database.value[0] : undefined;
    const databaseUp = typeof schemas?.catalog === 'boolean' && typeof schemas?.projection === 'boolean';
    const sandboxUp = workerState === 'disabled' || (this.sandbox?.status === 'ready'
      && schemas?.sandbox === true && runtime.status === 'fulfilled' && runtime.value);
    const projectionTables = !this.projectionDatabase ? 'not_configured' : projection.status !== 'fulfilled'
      ? 'unavailable' : projection.value ? 'ready' : 'missing';
    const projectionListener = !this.projectionListener ? 'not_configured' : this.projectionListener.ready ? 'ready' : 'unavailable';
    const projectionUp = !this.projectionDatabase || (projectionTables === 'ready' && projectionListener === 'ready');
    const ready = databaseUp && schemas?.catalog && schemas?.projection && sandboxUp && projectionUp;
    const response = {
      status: ready ? 'ok' : 'unavailable', scope: workerState === 'disabled' ? 'foundation' : 'engine-with-sql-sandbox',
      db: databaseUp ? 'up' : 'down',
      schemas: {
        catalog: databaseUp ? (schemas?.catalog ? 'present' : 'missing') : 'unknown',
        projection: databaseUp ? (schemas?.projection ? 'present' : 'missing') : 'unknown',
        sandbox: workerState === 'disabled' ? 'not_required' : databaseUp ? (schemas?.sandbox ? 'present' : 'missing') : 'unknown',
      },
      modules: { sessions: 'implemented', components: 'implemented', projection: 'implemented', scriptCatalog: 'implemented', sandbox: 'implemented' },
      messaging: this.runtime?.connected ? 'connected' : 'not_connected', sandboxWorker: this.sandbox?.status ?? 'disabled',
      sandboxRuntime: { developmentOnly: !this.config || this.config.runtimeClass === 'runc',
        errorCode: this.sandbox?.lastError ?? null },
      projection: { tables: projectionTables, listener: projectionListener,
        consumer: this.projectionRuntime?.connected ? 'connected' : 'not_connected',
        auth: this.config?.jwt ? 'configured' : 'not_configured',
        live: projectionTables === 'ready' && projectionListener === 'ready' && !!this.projectionRuntime?.connected && !!this.config?.jwt },
    };
    if (!ready) {
      this.logger.warn(`Engine unavailable: db=${response.db}, catalog=${response.schemas.catalog}, projection=${response.schemas.projection}, sandbox=${response.sandboxWorker}, projection_tables=${projectionTables}, projection_listener=${projectionListener}`);
      throw new ServiceUnavailableException(response);
    }
    return response;
  }
}
