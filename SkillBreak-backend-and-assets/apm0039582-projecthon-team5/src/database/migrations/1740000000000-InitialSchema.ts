import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1740000000000 implements MigrationInterface {
  name = 'InitialSchema1740000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE user_role AS ENUM ('player', 'admin')`);
    await queryRunner.query(`CREATE TYPE user_status AS ENUM ('active', 'disabled', 'deleted')`);
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username varchar(32) NOT NULL UNIQUE,
        email varchar(254) NOT NULL UNIQUE,
        display_name varchar(64) NOT NULL,
        password_hash text NOT NULL,
        role user_role NOT NULL DEFAULT 'player',
        status user_status NOT NULL DEFAULT 'active',
        token_version integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        CONSTRAINT ck_users_username CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
        CONSTRAINT ck_users_email CHECK (email = lower(btrim(email))),
        CONSTRAINT ck_users_display_name CHECK (char_length(display_name) BETWEEN 1 AND 64),
        CONSTRAINT ck_users_token_version CHECK (token_version >= 0),
        CONSTRAINT ck_users_deleted_at CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE refresh_families (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz NULL,
        CONSTRAINT ck_refresh_families_expiry CHECK (expires_at > created_at)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        family_id uuid NOT NULL REFERENCES refresh_families(id) ON DELETE RESTRICT,
        token_hash char(64) NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        used_at timestamptz NULL,
        CONSTRAINT ck_refresh_tokens_hash CHECK (token_hash ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query('CREATE INDEX ix_refresh_families_user ON refresh_families (user_id)');
    await queryRunner.query('CREATE INDEX ix_refresh_tokens_family ON refresh_tokens (family_id)');
    await queryRunner.query(`CREATE UNIQUE INDEX uq_refresh_tokens_unused ON refresh_tokens (family_id) WHERE used_at IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE refresh_tokens');
    await queryRunner.query('DROP TABLE refresh_families');
    await queryRunner.query('DROP TABLE users');
    await queryRunner.query('DROP TYPE user_status');
    await queryRunner.query('DROP TYPE user_role');
  }
}