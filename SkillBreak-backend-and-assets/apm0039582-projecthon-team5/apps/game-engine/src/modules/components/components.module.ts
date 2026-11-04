import { Module } from '@nestjs/common';
import { ComponentFactory } from './components';
import { HashPool } from './hash-pool';
import { ENGINE_RUNTIME_OPTIONS, EngineRuntimeOptions } from '../sessions/engine-options';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';
import { SandboxModule } from '../sandbox/sandbox.module';
import { SandboxExecutorService } from '../sandbox/sandbox-executor';

@Module({
	imports: [SandboxModule],
	providers: [
		{ provide: HashPool, useFactory: () => new HashPool() },
		{ provide: ComponentFactory, inject: [HashPool, SandboxExecutorService, ENGINE_CONFIG, { token: ENGINE_RUNTIME_OPTIONS, optional: true }],
			useFactory: (hashes: HashPool, executor: SandboxExecutorService, config: EngineConfig, options?: EngineRuntimeOptions) =>
				new ComponentFactory(options?.executor ?? (config.sandbox.enabled ? executor : undefined), hashes) },
	],
	exports: [ComponentFactory],
})
export class ComponentsModule {}
