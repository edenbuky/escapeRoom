import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from './config/config.module';
import { databaseOptions, ENGINE_CONFIG, EngineConfig } from './config/config';
import { HealthModule } from './health/health.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { ComponentsModule } from './modules/components/components.module';
import { ProjectionModule } from './modules/projection/projection.module';
import { ScriptCatalogModule } from './modules/script-catalog/script-catalog.module';
import { SandboxModule } from './modules/sandbox/sandbox.module';

export const engineModules = [HealthModule, SessionsModule, ComponentsModule, ProjectionModule, ScriptCatalogModule, SandboxModule];

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [ENGINE_CONFIG],
      useFactory: (config: EngineConfig) => databaseOptions(config),
    }),
    ...engineModules,
  ],
})
export class AppModule {}
