import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';
import { KubernetesDriver } from './kubernetes-driver';
import { SandboxRepository } from './sandbox.repository';
import { SandboxWorker } from './sandbox-worker';
import { SandboxExecutorService } from './sandbox-executor';

@Module({
  providers: [
    { provide: KubernetesDriver, inject: [ENGINE_CONFIG], useFactory: (config: EngineConfig) =>
      new KubernetesDriver({ runtimeClass: config.runtimeClass, kubeContext: config.sandbox.kubeContext,
        imageAllowlist: config.sandbox.imageAllowlist }) },
    { provide: SandboxRepository, inject: [DataSource, ENGINE_CONFIG],
      useFactory: (database: DataSource, config: EngineConfig) =>
        new SandboxRepository(database, config.sandbox.workerConcurrency) },
    { provide: SandboxWorker, inject: [DataSource, SandboxRepository, KubernetesDriver, ENGINE_CONFIG],
      useFactory: (database: DataSource, repository: SandboxRepository, driver: KubernetesDriver, config: EngineConfig) =>
        new SandboxWorker(database, repository, driver, config.sandbox.workerConcurrency) },
    { provide: SandboxExecutorService, inject: [DataSource, SandboxRepository, KubernetesDriver, SandboxWorker],
      useFactory: (database: DataSource, repository: SandboxRepository, driver: KubernetesDriver, worker: SandboxWorker) =>
        new SandboxExecutorService(database, repository, driver, () => worker.status === 'ready') },
  ],
  exports: [SandboxRepository, SandboxWorker, KubernetesDriver, SandboxExecutorService],
})
export class SandboxModule {}
