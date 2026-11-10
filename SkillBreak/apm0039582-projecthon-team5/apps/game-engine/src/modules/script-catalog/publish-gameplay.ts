import { AppDataSource } from '../../database/data-source';
import { CatalogRepository } from './catalog.repository';

async function publish() {
  await AppDataSource.initialize();
  try { await new CatalogRepository(AppDataSource).publishGameplay(); }
  finally { await AppDataSource.destroy(); }
}
void publish().catch(() => { console.error('Gameplay publication failed; check baseline catalog and immutable versions.'); process.exitCode = 1; });