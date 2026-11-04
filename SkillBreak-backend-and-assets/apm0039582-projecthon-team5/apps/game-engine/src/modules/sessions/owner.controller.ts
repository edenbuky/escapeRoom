import { Controller, Get, Header, NotFoundException, Param, ParseUUIDPipe, UseFilters, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CatalogErrorFilter, CatalogTokenGuard } from '../script-catalog/catalog.controller';

@Controller('internal/sessions')
@UseGuards(CatalogTokenGuard)
@UseFilters(CatalogErrorFilter)
export class OwnerController {
  constructor(private readonly database: DataSource) {}

  @Get(':id/owner')
  @Header('Cache-Control', 'no-store')
  async owner(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ ownerId: string }> {
    const rows: { ownerId: string }[] = await this.database.query('SELECT owner_id AS "ownerId" FROM sessions WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }
}