import 'reflect-metadata';
import { AppModule } from '../src/app.module';
import { SessionsModule } from '../src/modules/sessions/sessions.module';
import { ComponentsModule } from '../src/modules/components/components.module';
import { ProjectionModule } from '../src/modules/projection/projection.module';
import { ScriptCatalogModule } from '../src/modules/script-catalog/script-catalog.module';
import { SandboxModule } from '../src/modules/sandbox/sandbox.module';
import { CatalogController } from '../src/modules/script-catalog/catalog.controller';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { EngineService } from '../src/modules/sessions/engine.service';
import { OwnerController } from '../src/modules/sessions/owner.controller';
import { SandboxExecutorService } from '../src/modules/sandbox/sandbox-executor';
import { SandboxRepository } from '../src/modules/sandbox/sandbox.repository';
import { SandboxWorker } from '../src/modules/sandbox/sandbox-worker';
import { SANDBOX_DRIVER } from '../src/modules/sandbox/sandbox-driver';
import { SandboxEngineBridge } from '../src/modules/sessions/sandbox-engine.bridge';

test('catalog, engine, SQL sandbox and projection are in-process modules', () => {
  const modules = [ProjectionModule];
  const imports: unknown[] = Reflect.getMetadata('imports', AppModule);
  for (const module of modules) {
    expect(imports).toContain(module);
    expect(Reflect.getMetadata('providers', module).length).toBeGreaterThan(0);
    expect(Reflect.getMetadata('controllers', module).length).toBe(1);
  }
  expect(imports).toContain(ScriptCatalogModule);
  expect(Reflect.getMetadata('controllers', ScriptCatalogModule)).toEqual([CatalogController]);
  expect(Reflect.getMetadata('providers', ScriptCatalogModule)).toContain(CatalogRepository);
  expect(Reflect.getMetadata('exports', ScriptCatalogModule)).toEqual([CatalogRepository]);
  expect(imports).toContain(SessionsModule);
  expect(imports).toContain(ComponentsModule);
  expect(Reflect.getMetadata('controllers', SessionsModule)).toEqual([OwnerController]);
  expect(Reflect.getMetadata('providers', SessionsModule)).toContain(EngineService);
  expect(Reflect.getMetadata('providers', SessionsModule)).toContain(SandboxEngineBridge);
  expect(imports).toContain(SandboxModule);
  expect(Reflect.getMetadata('controllers', SandboxModule) ?? []).toEqual([]);
  expect(Reflect.getMetadata('exports', SandboxModule)).toEqual([
    SandboxRepository, SandboxWorker, SANDBOX_DRIVER, SandboxExecutorService,
  ]);
});
