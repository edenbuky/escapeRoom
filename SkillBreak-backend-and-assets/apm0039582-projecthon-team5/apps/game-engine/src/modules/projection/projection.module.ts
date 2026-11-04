import { Module } from '@nestjs/common';
import { ProjectionDatabase } from './projection-database';
import { ProjectionRepository } from './projection.repository';
import { ProjectionListener } from './projection.listener';
import { SessionStreamGuard } from './session-stream.guard';
import { SessionStreamService } from './session-stream.service';
import { SessionStreamController } from './session-stream.controller';
import { ProjectionConsumer } from './projection.consumer';
import { ProjectionRuntime } from './projection.runtime';

@Module({
  providers: [ProjectionDatabase, ProjectionRepository, ProjectionListener, SessionStreamGuard, SessionStreamService, ProjectionConsumer, ProjectionRuntime],
  controllers: [SessionStreamController],
  exports: [ProjectionDatabase, ProjectionListener, ProjectionRuntime],
})
export class ProjectionModule {}
