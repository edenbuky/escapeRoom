import { Controller, ForbiddenException, Get, Inject, Param, ParseUUIDPipe, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ENGINE_CONFIG, type EngineConfig } from '../../config/config';
import { SessionStreamGuard, type StreamRequest } from './session-stream.guard';
import { SessionStreamService, validateCursor } from './session-stream.service';

@Controller('sessions')
@UseGuards(SessionStreamGuard)
export class SessionStreamController {
  constructor(private readonly streams: SessionStreamService, @Inject(ENGINE_CONFIG) private readonly config: EngineConfig) {}
  @Get(':sid/stream')
  async stream(@Param('sid', new ParseUUIDPipe()) sid: string, @Req() request: StreamRequest, @Res() response: Response): Promise<void> {
    if (request.headers.origin && !this.config.corsOrigins.includes(request.headers.origin)) throw new ForbiddenException();
    validateCursor(request.headers['last-event-id']);
    await this.streams.open(sid.toLowerCase(), request.projectionAuth, response);
  }
}
