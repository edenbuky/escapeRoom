import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EngineSchema1793570402000 implements MigrationInterface {
  async up(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query(`
      CREATE TABLE sessions (
        id uuid PRIMARY KEY, owner_id uuid NOT NULL, script_id text NOT NULL, script_version int NOT NULL,
        version int NOT NULL CHECK (version > 0), state jsonb NOT NULL, last_seen_at timestamptz NOT NULL
      );
      CREATE TABLE session_puzzles (
        session_id uuid NOT NULL REFERENCES sessions(id), puzzle_key text NOT NULL, state jsonb NOT NULL,
        PRIMARY KEY (session_id, puzzle_key)
      );
      CREATE TABLE command_log (
        command_id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id), puzzle_key text,
        input_redacted text NOT NULL CHECK (input_redacted = '[redacted]'), verdict text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE engine_sandbox_requests (
        job_id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id), request jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE messaging_outbox (
        message_id varchar(128) PRIMARY KEY, stream varchar(32) NOT NULL, session_id varchar(128) NOT NULL,
        payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
      );
      CREATE INDEX "IDX_messaging_outbox_pending_order" ON messaging_outbox(published_at, created_at, message_id);
      CREATE TABLE messaging_inbox_receipt (
        consumer varchar(128) NOT NULL, message_id varchar(128) NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer, message_id)
      );
      CREATE TABLE messaging_consumer_attempt (
        consumer varchar(128) NOT NULL, message_id varchar(128) NOT NULL, attempt_count smallint NOT NULL,
        last_failure varchar(1024), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, message_id)
      );
      CREATE TABLE messaging_dead_letter (
        consumer varchar(128) NOT NULL, message_id varchar(128) NOT NULL, attempt_count smallint NOT NULL,
        failure_details varchar(1024) NOT NULL, failed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, message_id)
      );
    `);
  }
  async down(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query(`DROP TABLE messaging_dead_letter, messaging_consumer_attempt, messaging_inbox_receipt,
      messaging_outbox, engine_sandbox_requests, command_log, session_puzzles, sessions`);
  }
}