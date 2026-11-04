import { Module } from '@nestjs/common';
import { CatalogController, CatalogTokenGuard } from './catalog.controller';
import { CatalogRepository } from './catalog.repository';

@Module({
	controllers: [CatalogController],
	providers: [CatalogRepository, CatalogTokenGuard],
	exports: [CatalogRepository],
})
export class ScriptCatalogModule {}
