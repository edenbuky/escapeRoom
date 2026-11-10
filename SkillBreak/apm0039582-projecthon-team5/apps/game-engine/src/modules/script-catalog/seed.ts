import { AppDataSource as database } from '../../database/data-source';
import { CatalogRepository } from './catalog.repository';

async function seed(): Promise<void> {
  await database.initialize();
  try { await new CatalogRepository(database).seed(); }
  finally { await database.destroy(); }
}
seed().catch(() => {
  process.stderr.write('Catalog seed failed; check migrations and conflicting versioned content.\n');
  process.exitCode = 1;
});