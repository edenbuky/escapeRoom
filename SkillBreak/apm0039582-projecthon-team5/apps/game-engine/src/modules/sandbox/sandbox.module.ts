import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';
import { EmbeddedDriver } from './embedded-driver';
import { KubernetesDriver } from './kubernetes-driver';
import { SANDBOX_DRIVER, type SandboxDriver } from './sandbox-driver';
import { SandboxRepository } from './sandbox.repository';
import { SandboxWorker } from './sandbox-worker';
import { SandboxExecutorService } from './sandbox-executor';

@Module({
  providers: [
    { provide: SANDBOX_DRIVER, inject: [ENGINE_CONFIG], useFactory: (config: EngineConfig): SandboxDriver =>
      config.sandbox.driver === 'kubernetes'
        ? new KubernetesDriver({ runtimeClass: config.runtimeClass, kubeContext: config.sandbox.kubeContext,
          imageAllowlist: config.sandbox.imageAllowlist })
        : new EmbeddedDriver() },
    { provide: SandboxRepository, inject: [DataSource, ENGINE_CONFIG],
      useFactory: (database: DataSource, config: EngineConfig) =>
        new SandboxRepository(database, config.sandbox.workerConcurrency) },
    { provide: SandboxWorker, inject: [DataSource, SandboxRepository, SANDBOX_DRIVER, ENGINE_CONFIG],
      useFactory: (database: DataSource, repository: SandboxRepository, driver: SandboxDriver, config: EngineConfig) =>
        new SandboxWorker(database, repository, driver, config.sandbox.workerConcurrency) },
    { provide: SandboxExecutorService, inject: [DataSource, SandboxRepository, SANDBOX_DRIVER, SandboxWorker],
      useFactory: (database: DataSource, repository: SandboxRepository, driver: SandboxDriver, worker: SandboxWorker) =>
        new SandboxExecutorService(database, repository, driver, () => worker.status === 'ready') },
  ],
  exports: [SandboxRepository, SandboxWorker, SANDBOX_DRIVER, SandboxExecutorService],
})
export class SandboxModule {}
