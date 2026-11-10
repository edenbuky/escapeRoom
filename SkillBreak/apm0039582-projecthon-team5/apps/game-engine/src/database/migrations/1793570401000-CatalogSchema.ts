import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CatalogSchema1793570401000 implements MigrationInterface {
  async up(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query(`
      CREATE TABLE team5.scripts (id text PRIMARY KEY, slug text NOT NULL UNIQUE, current_version int);
      CREATE TABLE team5.script_versions (
        script_id text NOT NULL REFERENCES team5.scripts(id), version int NOT NULL CHECK (version > 0),
        status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
        definition jsonb NOT NULL, published_at timestamptz, PRIMARY KEY (script_id, version)
      );
      CREATE TABLE team5.component_templates (
        key text NOT NULL, version int NOT NULL CHECK (version > 0),
        family text NOT NULL CHECK (family IN ('sandbox', 'input')), engine text NOT NULL,
        definition jsonb NOT NULL, status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
        PRIMARY KEY (key, version)
      );
      CREATE FUNCTION team5.guard_published_content() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('published', 'retired') THEN
          IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Published content is immutable'; END IF;
          IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
            OR NEW.status NOT IN ('published', 'retired')
            OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
            RAISE EXCEPTION 'Published content is immutable';
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER immutable_script BEFORE UPDATE OR DELETE ON team5.script_versions
        FOR EACH ROW EXECUTE FUNCTION team5.guard_published_content();
      CREATE TRIGGER immutable_template BEFORE UPDATE OR DELETE ON team5.component_templates
        FOR EACH ROW EXECUTE FUNCTION team5.guard_published_content();
    `);
  }
  async down(runner: Pick<QueryRunner, 'query'>): Promise<void> {
    await runner.query(`DROP TABLE team5.component_templates, team5.script_versions, team5.scripts;
      DROP FUNCTION team5.guard_published_content();`);
  }
}