import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FoundationSchemas1793570400000 implements MigrationInterface {
  async up(queryRunner: Pick<QueryRunner, 'query'>): Promise<void> {
    await queryRunner.query('CREATE SCHEMA IF NOT EXISTS catalog');
    await queryRunner.query('CREATE SCHEMA IF NOT EXISTS projection');
  }
  async down(queryRunner: Pick<QueryRunner, 'query'>): Promise<void> {
    await queryRunner.query('DROP SCHEMA IF EXISTS projection');
    await queryRunner.query('DROP SCHEMA IF EXISTS catalog');
  }
}
