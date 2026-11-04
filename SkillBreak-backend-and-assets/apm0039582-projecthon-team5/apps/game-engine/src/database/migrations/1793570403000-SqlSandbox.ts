import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SqlSandbox1793570403000 implements MigrationInterface {
  async up(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query(`
      ALTER TABLE engine_sandbox_requests
        ADD COLUMN status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','running','waiting_cleanup','completed','failed','superseded')),
        ADD COLUMN first_attempt_at timestamptz,
        ADD COLUMN deadline_at timestamptz,
        ADD COLUMN readiness_started_at timestamptz,
        ADD COLUMN readiness_checks int NOT NULL DEFAULT 0 CHECK (readiness_checks BETWEEN 0 AND 3),
        ADD COLUMN attempt_count int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN last_error_code text CHECK (last_error_code ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'),
        ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
        ADD CONSTRAINT sandbox_job_deadline CHECK (
          (first_attempt_at IS NULL AND deadline_at IS NULL) OR
          (first_attempt_at IS NOT NULL AND (
            (request->>'operation' = 'destroy' AND deadline_at IS NULL) OR
            (request->>'operation' = 'provision' AND deadline_at IS NOT NULL
              AND deadline_at = first_attempt_at + interval '60 seconds')))),
        ADD CONSTRAINT sandbox_job_readiness CHECK (
          (readiness_started_at IS NULL AND readiness_checks = 0) OR
          (readiness_started_at IS NOT NULL AND first_attempt_at IS NOT NULL
            AND readiness_started_at >= first_attempt_at));
      CREATE INDEX sandbox_jobs_runnable ON engine_sandbox_requests(next_attempt_at,created_at,job_id)
        WHERE status IN ('pending','running','waiting_cleanup');
      CREATE INDEX sandbox_jobs_identity ON engine_sandbox_requests
        (session_id,(request->>'puzzleKey'),(request->>'generation'));

      CREATE TABLE sandbox_instances (
        sandbox_id text PRIMARY KEY,
        session_id uuid NOT NULL,
        puzzle_key text NOT NULL CHECK (length(puzzle_key) BETWEEN 1 AND 128),
        generation int NOT NULL CHECK (generation > 0),
        namespace text NOT NULL CHECK (namespace = 'team5-sandboxes'),
        pod_name text NOT NULL,
        pod_uid text CHECK (length(pod_uid) BETWEEN 1 AND 128),
        template_ref text NOT NULL CHECK (template_ref ~ '^[a-z0-9][a-z0-9-]*@[1-9][0-9]*$'),
        image_digest text NOT NULL CHECK (
          image_digest ~ '^[a-z0-9][a-z0-9.:-]*/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$'),
        seed_ref text NOT NULL CHECK (seed_ref = 'room1-sql-v1'),
        policy_ref text NOT NULL CHECK (policy_ref = template_ref),
        desired_state text NOT NULL DEFAULT 'ready' CHECK (desired_state IN ('ready','destroyed')),
        status text NOT NULL DEFAULT 'provisioning'
          CHECK (status IN ('provisioning','ready','failed','destroying','destroyed','unavailable')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        lease_expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
        max_expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
        active_command_id uuid,
        last_error_code text CHECK (last_error_code ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'),
        UNIQUE (session_id,puzzle_key,generation),
        UNIQUE (namespace,pod_name),
        FOREIGN KEY (session_id,puzzle_key) REFERENCES session_puzzles(session_id,puzzle_key),
        CHECK (sandbox_id = pod_name AND pod_name = 'sbx-' || substr(encode(sha256(convert_to(
          session_id::text || ':' || puzzle_key || ':' || generation::text,'UTF8')),'hex'),1,32)),
        CHECK (max_expires_at = created_at + interval '2 hours'),
        CHECK (lease_expires_at >= created_at AND lease_expires_at <= max_expires_at),
        CHECK (status <> 'ready' OR (pod_uid IS NOT NULL AND desired_state = 'ready')),
        CHECK (status NOT IN ('destroying','destroyed') OR desired_state = 'destroyed')
      );
      CREATE TABLE sandbox_executions (
        command_id uuid PRIMARY KEY,
        sandbox_id text NOT NULL REFERENCES sandbox_instances(sandbox_id),
        input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
        execution_token uuid NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','interrupted')),
        stdout text NOT NULL DEFAULT '',
        stderr text NOT NULL DEFAULT '',
        exit_code int,
        timed_out boolean NOT NULL DEFAULT false,
        truncated boolean NOT NULL DEFAULT false,
        error_code text CHECK (error_code ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'),
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        quiesced_at timestamptz,
        UNIQUE (command_id,sandbox_id),
        CHECK (octet_length(stdout) + octet_length(stderr) <= 65536),
        CHECK ((status = 'running' AND finished_at IS NULL AND quiesced_at IS NULL
            AND stdout = '' AND stderr = '' AND exit_code IS NULL AND NOT timed_out AND NOT truncated)
          OR (status <> 'running' AND finished_at IS NOT NULL AND quiesced_at IS NOT NULL
            AND finished_at >= started_at AND quiesced_at >= started_at)),
        CHECK (status <> 'interrupted' OR (exit_code IS NULL AND error_code IS NOT NULL)),
        CHECK (NOT timed_out OR exit_code IS NULL)
      );
      CREATE UNIQUE INDEX sandbox_one_running_command ON sandbox_executions(sandbox_id) WHERE status = 'running';
      ALTER TABLE sandbox_instances ADD CONSTRAINT sandbox_active_command
        FOREIGN KEY (active_command_id,sandbox_id) REFERENCES sandbox_executions(command_id,sandbox_id)
        DEFERRABLE INITIALLY DEFERRED;

      CREATE TABLE sandbox_outcomes (
        job_id uuid NOT NULL REFERENCES engine_sandbox_requests(job_id),
        kind text NOT NULL CHECK (kind IN ('ready','failed','destroyed')),
        payload jsonb NOT NULL,
        delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','delivered','superseded')),
        attempt_count int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error_code text CHECK (last_error_code ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'),
        created_at timestamptz NOT NULL DEFAULT now(),
        delivered_at timestamptz,
        PRIMARY KEY (job_id,kind),
        CHECK ((jsonb_typeof(payload) = 'object' AND payload->>'jobId' = job_id::text AND payload->>'kind' = kind
          AND jsonb_typeof(payload->'occurredAt') = 'string'
          AND jsonb_typeof(payload->'sessionId') = 'string'
          AND jsonb_typeof(payload->'puzzleKey') = 'string'
          AND jsonb_typeof(payload->'generation') = 'number'
          AND payload->>'namespace' = 'team5-sandboxes' AND jsonb_typeof(payload->'podName') = 'string') IS TRUE),
        CHECK (delivery_status <> 'delivered' OR delivered_at IS NOT NULL)
      );
      CREATE INDEX sandbox_outcomes_runnable ON sandbox_outcomes(next_attempt_at,created_at,job_id)
        WHERE delivery_status = 'pending';

      CREATE FUNCTION sandbox_guard_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.job_id,NEW.session_id,NEW.request,NEW.created_at) IS DISTINCT FROM
           (OLD.job_id,OLD.session_id,OLD.request,OLD.created_at)
          OR (OLD.first_attempt_at IS NOT NULL AND (NEW.first_attempt_at,NEW.deadline_at) IS DISTINCT FROM
              (OLD.first_attempt_at,OLD.deadline_at))
          OR (OLD.readiness_started_at IS NOT NULL AND NEW.readiness_started_at IS DISTINCT FROM OLD.readiness_started_at)
          OR NEW.readiness_checks < OLD.readiness_checks OR NEW.attempt_count < OLD.attempt_count THEN
          RAISE EXCEPTION 'Immutable sandbox job state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER sandbox_job_immutable BEFORE UPDATE ON engine_sandbox_requests
        FOR EACH ROW EXECUTE FUNCTION sandbox_guard_job();

      CREATE FUNCTION sandbox_guard_instance() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.sandbox_id,NEW.session_id,NEW.puzzle_key,NEW.generation,NEW.namespace,NEW.pod_name,
            NEW.template_ref,NEW.image_digest,NEW.seed_ref,NEW.policy_ref,NEW.created_at,NEW.max_expires_at)
          IS DISTINCT FROM
           (OLD.sandbox_id,OLD.session_id,OLD.puzzle_key,OLD.generation,OLD.namespace,OLD.pod_name,
            OLD.template_ref,OLD.image_digest,OLD.seed_ref,OLD.policy_ref,OLD.created_at,OLD.max_expires_at)
          OR (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
          OR (OLD.desired_state = 'destroyed' AND NEW.desired_state <> 'destroyed')
          OR (OLD.status = 'destroyed' AND NEW.status <> 'destroyed') THEN
          RAISE EXCEPTION 'Immutable sandbox identity or destruction' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER sandbox_instance_immutable BEFORE UPDATE ON sandbox_instances
        FOR EACH ROW EXECUTE FUNCTION sandbox_guard_instance();

      CREATE FUNCTION sandbox_guard_execution() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.command_id,NEW.sandbox_id,NEW.input_hash,NEW.execution_token,NEW.started_at) IS DISTINCT FROM
           (OLD.command_id,OLD.sandbox_id,OLD.input_hash,OLD.execution_token,OLD.started_at)
          OR (OLD.status <> 'running' AND NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'Immutable sandbox execution' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER sandbox_execution_immutable BEFORE UPDATE ON sandbox_executions
        FOR EACH ROW EXECUTE FUNCTION sandbox_guard_execution();

      CREATE FUNCTION sandbox_check_active() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target text;
      BEGIN
        target := NEW.sandbox_id;
        IF EXISTS (SELECT 1 FROM sandbox_instances i WHERE i.sandbox_id = target AND
          i.active_command_id IS DISTINCT FROM
            (SELECT e.command_id FROM sandbox_executions e WHERE e.sandbox_id = target AND e.status = 'running')) THEN
          RAISE EXCEPTION 'Sandbox active execution mismatch' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER sandbox_instance_active AFTER INSERT OR UPDATE ON sandbox_instances
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sandbox_check_active();
      CREATE CONSTRAINT TRIGGER sandbox_execution_active AFTER INSERT OR UPDATE ON sandbox_executions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sandbox_check_active();

      CREATE FUNCTION sandbox_guard_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE request jsonb;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF (NEW.job_id,NEW.kind,NEW.payload,NEW.created_at) IS DISTINCT FROM
             (OLD.job_id,OLD.kind,OLD.payload,OLD.created_at) OR NEW.attempt_count < OLD.attempt_count THEN
            RAISE EXCEPTION 'Immutable sandbox outcome' USING ERRCODE = '23514';
          END IF;
        END IF;
        SELECT j.request INTO request FROM engine_sandbox_requests j WHERE j.job_id = NEW.job_id;
        IF (NEW.payload @> jsonb_build_object('sessionId',request->'sessionId','puzzleKey',request->'puzzleKey',
            'generation',request->'generation','namespace',request->'namespace','podName',request->'podName')) IS NOT TRUE
          OR (NEW.kind = 'ready' AND request->>'operation' IS DISTINCT FROM 'provision')
          OR (NEW.kind = 'destroyed' AND request->>'operation' IS DISTINCT FROM 'destroy')
          OR (NEW.kind = 'failed' AND (NEW.payload->>'operation' IS DISTINCT FROM request->>'operation'
            OR (NEW.payload->>'errorCode' ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$') IS NOT TRUE)) THEN
          RAISE EXCEPTION 'Sandbox outcome identity mismatch' USING ERRCODE = '23514';
        END IF;
        PERFORM (NEW.payload->>'occurredAt')::timestamptz;
        RETURN NEW;
      END $$;
      CREATE TRIGGER sandbox_outcome_immutable BEFORE INSERT OR UPDATE ON sandbox_outcomes
        FOR EACH ROW EXECUTE FUNCTION sandbox_guard_outcome();
    `);
  }

  async down(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query(`
      DROP TABLE sandbox_outcomes;
      ALTER TABLE sandbox_instances DROP CONSTRAINT sandbox_active_command;
      DROP TABLE sandbox_executions;
      DROP TABLE sandbox_instances;
      DROP TRIGGER sandbox_job_immutable ON engine_sandbox_requests;
      DROP FUNCTION sandbox_guard_outcome(), sandbox_check_active(), sandbox_guard_execution(),
        sandbox_guard_instance(), sandbox_guard_job();
      DROP INDEX sandbox_jobs_runnable;
      DROP INDEX sandbox_jobs_identity;
      ALTER TABLE engine_sandbox_requests DROP CONSTRAINT sandbox_job_deadline,
        DROP CONSTRAINT sandbox_job_readiness, DROP COLUMN status, DROP COLUMN first_attempt_at,
        DROP COLUMN deadline_at, DROP COLUMN readiness_started_at, DROP COLUMN readiness_checks,
        DROP COLUMN attempt_count, DROP COLUMN next_attempt_at, DROP COLUMN last_error_code, DROP COLUMN updated_at;
    `);
  }
}
