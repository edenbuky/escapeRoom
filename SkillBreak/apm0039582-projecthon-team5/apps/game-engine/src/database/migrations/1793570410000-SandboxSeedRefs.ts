import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Sandboxes are no longer SQL-only: Room 2's embedded git terminal is provisioned from its own seed. */
export class SandboxSeedRefs1793570410000 implements MigrationInterface {
  name = 'SandboxSeedRefs1793570410000';

  async up(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query('ALTER TABLE sandbox_instances DROP CONSTRAINT sandbox_instances_seed_ref_check');
    await runner.query(`ALTER TABLE sandbox_instances ADD CONSTRAINT sandbox_instances_seed_ref_check
      CHECK (seed_ref IN ('room1-sql-v1','room2-git-v1'))`);
  }

  async down(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query('ALTER TABLE sandbox_instances DROP CONSTRAINT sandbox_instances_seed_ref_check');
    // NOT VALID: existing git sandbox rows (if any) are kept, new rows are SQL-only again.
    await runner.query(`ALTER TABLE sandbox_instances ADD CONSTRAINT sandbox_instances_seed_ref_check
      CHECK (seed_ref = 'room1-sql-v1') NOT VALID`);
  }
}
