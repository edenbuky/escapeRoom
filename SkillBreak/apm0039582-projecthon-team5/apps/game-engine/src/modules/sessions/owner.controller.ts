import { Body, Controller, Get, Header, NotFoundException, Param, ParseUUIDPipe, Post, UseFilters, UseGuards } from '@nestjs/common';
import { IsUUID, Matches } from 'class-validator';
import { EngineService } from './engine.service';
import { DataSource } from 'typeorm';
import { CatalogErrorFilter, CatalogTokenGuard } from '../script-catalog/catalog.controller';

class InternalStartDto {
  @IsUUID() userId!: string;
  @IsUUID() requestId!: string;
  @Matches(/^[a-z0-9-]{1,64}$/) scriptSlug!: string;
}

@Controller('internal/sessions')
@UseGuards(CatalogTokenGuard)
@UseFilters(CatalogErrorFilter)
export class OwnerController {
  constructor(private readonly database: DataSource, private readonly engine: EngineService) {}

  @Post('start')
  start(@Body() input: InternalStartDto) {
    return this.engine.startOrResume(input.userId.toLowerCase(), input.scriptSlug, input.requestId.toLowerCase());
  }

  @Get('users/:id/resume')
  resume(@Param('id', new ParseUUIDPipe()) id: string) { return this.engine.resume(id.toLowerCase()); }

  @Get(':id/owner')
  @Header('Cache-Control', 'no-store')
  async owner(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ownerId: string }> {
    const rows: { ownerId: string }[] = await this.database.query('SELECT owner_id AS "ownerId" FROM sessions WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }
}