import { SessionProjection1793570404000 } from '../src/database/migrations/1793570404000-SessionProjection';

test('projection forward migration owns exactly its four tables and validates identity/version', async () => {
  const query = jest.fn().mockResolvedValue(undefined);
  const migration = new SessionProjection1793570404000();
  await migration.up({ query });
  const sql = query.mock.calls.map(call => call[0]).join('\n');
  for (const table of ['session_view', 'projection_messaging_inbox_receipt', 'projection_messaging_consumer_attempt', 'projection_messaging_dead_letter']) {
    expect(sql).toContain(`CREATE TABLE team5.${table}`);
  }
  expect(sql).toContain('CHECK (version > 0)');
  expect(sql).toContain('CHECK (revision > 0)');
  expect(sql).toContain("view->>'sessionId'");
  expect(sql).not.toMatch(/REFERENCES|ALTER TABLE|CREATE TABLE public/);
  await migration.down({ query });
  expect(query.mock.calls.at(-1)?.[0]).not.toMatch(/CASCADE|DROP SCHEMA/);
});
