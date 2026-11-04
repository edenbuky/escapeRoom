import { Module } from '@nestjs/common';
import { ComponentsModule } from '../components/components.module';
import { ScriptCatalogModule } from '../script-catalog/script-catalog.module';
import { CatalogTokenGuard } from '../script-catalog/catalog.controller';
import { CatalogResolver } from './catalog-resolver';
import { EngineRepository } from './engine.repository';
import { EngineService } from './engine.service';
import { EngineRuntime } from './engine-runtime';
import { OwnerController } from './owner.controller';
import { SandboxModule } from '../sandbox/sandbox.module';
import { SandboxEngineBridge } from './sandbox-engine.bridge';

@Module({
	imports: [ComponentsModule, ScriptCatalogModule, SandboxModule],
	controllers: [OwnerController],
	providers: [CatalogResolver, EngineRepository, EngineService, EngineRuntime, CatalogTokenGuard, SandboxEngineBridge],
	exports: [EngineService, EngineRuntime],
})
export class SessionsModule {}
