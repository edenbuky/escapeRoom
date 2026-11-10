const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.resolve(__dirname, '../../scripts/migrate-shared.js');
const env = { DB_HOST: 'db.example', DB_PORT: '5432', DB_USER: 'team5', DB_PASSWORD: 'example',
  DB_NAME: 'tdp-2026-db', DB_SSL: 'true' };

test.each([
  [{ ...env, DB_NAME: 'other' }, 'DB_NAME=tdp-2026-db'],
  [{ ...env, DB_SSL: 'false' }, 'DB_SSL=true'],
  [{ ...env, DB_HOST: 'invalid/host' }, 'DB_HOST must be a hostname'],
  [{ ...env, DB_PASSWORD: '' }, 'DB_PASSWORD is required'],
])('shared migration rejects an unsafe target before connecting', (values, message) => {
  const result = spawnSync(process.execPath, [script], { env: values, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
});
