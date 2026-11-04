import 'reflect-metadata';
import { Global, INestApplication, Module, OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule, engineModules } from './app.module';
import { databaseOptions, ENGINE_CONFIG, EngineConfig, loadEngineConfig } from './config/config';
import { ENGINE_RUNTIME_OPTIONS, EngineRuntimeOptions } from './modules/sessions/engine-options';
import { ENGINE_CLOCK } from './modules/sessions/engine.service';

export interface EngineAppOptions extends EngineRuntimeOptions {
  config?: EngineConfig;
  database?: DataSource;
  clock?: () => Date;
}

export async function createEngineApp(options?: EngineAppOptions): Promise<INestApplication> {
  if (!options) {
    const app = await NestFactory.create(AppModule, { abortOnError: false });
    configureCors(app, app.get<EngineConfig>(ENGINE_CONFIG));
    try { await app.init(); return app; }
    catch (error) { await app.close(); throw error; }
  }
  const config = options.config ?? loadEngineConfig();
  const database = options.database ?? new DataSource(databaseOptions(config));
  const owned = !options.database;
  if (owned) await database.initialize();
  else if (!database.isInitialized) throw new Error('Injected engine database must be initialized');
  class DatabaseLifetime implements OnApplicationShutdown {
    async onApplicationShutdown(): Promise<void> { if (owned && database.isInitialized) await database.destroy(); }
  }
  @Global()
  @Module({
    providers: [{ provide: DataSource, useValue: database }, { provide: ENGINE_CONFIG, useValue: config },
      { provide: ENGINE_RUNTIME_OPTIONS, useValue: options },
      { provide: ENGINE_CLOCK, useValue: options.clock ?? (() => new Date()) }, DatabaseLifetime],
    exports: [DataSource, ENGINE_CONFIG, ENGINE_RUNTIME_OPTIONS, ENGINE_CLOCK],
  })
  class EngineDependencies {}
  @Module({ imports: [EngineDependencies, ...engineModules] })
  class InjectedEngineApp {}
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(InjectedEngineApp, { logger: false, abortOnError: false });
    configureCors(app, config);
    await app.init();
    return app;
  } catch (error) {
    const cleanup: unknown[] = [];
    try { if (app) await app.close(); } catch (failure) { cleanup.push(failure); }
    try { if (owned && database.isInitialized) await database.destroy(); } catch (failure) { cleanup.push(failure); }
    if (cleanup.length) throw new AggregateError([error, ...cleanup], 'Engine startup and cleanup failed');
    throw error;
  }
}

function configureCors(app: INestApplication, config: EngineConfig): void {
  app.enableCors({ origin: config.corsOrigins, methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Last-Event-ID', 'Accept'], exposedHeaders: ['Retry-After'] });
}