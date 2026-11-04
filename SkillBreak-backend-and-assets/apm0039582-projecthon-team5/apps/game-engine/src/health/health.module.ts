import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RedisHealthService } from './redis-health.service';
import { SessionsModule } from '../modules/sessions/sessions.module';
import { SandboxModule } from '../modules/sandbox/sandbox.module';
import { ProjectionModule } from '../modules/projection/projection.module';

@Module({ imports: [SessionsModule, SandboxModule, ProjectionModule], controllers: [HealthController], providers: [RedisHealthService] })
export class HealthModule {}
