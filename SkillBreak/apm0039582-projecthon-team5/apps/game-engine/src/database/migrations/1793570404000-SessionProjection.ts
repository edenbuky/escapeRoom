import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionProjection1793570404000 implements MigrationInterface {
  async up(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query(`
      CREATE TABLE team5.session_view (
        session_id uuid PRIMARY KEY,
        owner_id uuid NOT NULL,
        version integer NOT NULL CHECK (version > 0),
        revision bigint NOT NULL CHECK (revision > 0),
        view jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (jsonb_typeof(view) = 'object'),
        CHECK (view ? 'sessionId' AND view->>'sessionId' = session_id::text),
        CHECK (view ? 'version' AND view->'version' = to_jsonb(version))
      );
      CREATE TABLE team5.projection_messaging_inbox_receipt (
        consumer varchar(128) NOT NULL, message_id varchar(128) NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, message_id)
      );
      CREATE TABLE team5.projection_messaging_consumer_attempt (
        consumer varchar(128) NOT NULL, message_id varchar(128) NOT NULL,
        attempt_count smallint NOT NULL, last_failure varchar(1024),
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, message_id)
      );
      CREATE TABLE team5.projection_messaging_dead_letter (
        consumer varchar(128) NOT NULL, message_id varchar(128) NOT NULL,
        attempt_count smallint NOT NULL, failure_details varchar(1024) NOT NULL,
        failed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, message_id)
      );
    `);
  }
  async down(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query(`DROP TABLE team5.projection_messaging_dead_letter, team5.projection_messaging_consumer_attempt,
      team5.projection_messaging_inbox_receipt, team5.session_view`);
  }
}
