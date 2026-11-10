const { Client } = require('pg');
const { DataSource } = require('typeorm');

async function main() {
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_SSL']) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  if (process.env.DB_NAME !== 'tdp-2026-db' || process.env.DB_SSL !== 'true') {
    throw new Error('Shared migrations require DB_NAME=tdp-2026-db and DB_SSL=true');
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(process.env.DB_HOST)) throw new Error('DB_HOST must be a hostname');

  const { AppDataSource: users } = require('../src/runtime/database/data-source');
  const { databaseOptions } = require('../apps/game-engine/dist/config/config');
  const engineUrl = `postgresql://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASSWORD)}`
    + `@${process.env.DB_HOST}:${process.env.DB_PORT}/${encodeURIComponent(process.env.DB_NAME)}`;
  const engine = new DataSource(databaseOptions({ databaseUrl: engineUrl, databaseSsl: true }));
  const client = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
  });
  let locked = false;
  try {
    await client.connect();
    const result = await client.query(`SELECT current_database() AS database,
      pg_try_advisory_lock(hashtextextended('team5:schema-migrations', 0)) AS locked`);
    locked = result.rows[0].locked;
    if (result.rows[0].database !== 'tdp-2026-db' || !locked) {
      throw new Error('Wrong database or another Team 5 migration is running');
    }
    await client.query('CREATE SCHEMA IF NOT EXISTS team5');
    for (const [name, source] of [['Users', users], ['Engine', engine]]) {
      try {
        await source.initialize();
        const applied = await source.runMigrations({ transaction: 'all' });
        console.log(`${name}: ${applied.length} migration(s) applied`);
      } finally {
        if (source.isInitialized) await source.destroy();
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('team5:schema-migrations', 0))");
    await client.end();
  }
}

main().catch(error => {
  console.error('Shared migration failed:', error.message);
  process.exitCode = 1;
});
