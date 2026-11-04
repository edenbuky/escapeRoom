# SkillBreak module-oriented monorepo baseline

**Status:** Task 1.1 foundation implemented as a draft; joint contract approval remains pending.
**Scope:** Backend capability modules, package boundaries, local prerequisites and validation.
**Source precedence:** [Feature clarifications](specs/001-shared-contracts-stack/spec.md) supersede the older four-service/five-stream topology in [DESIGN-v2](DESIGN-v2.md) for this feature. The previously referenced CONTRACTS-feature1.md is absent; the [current contract proposal](specs/001-shared-contracts-stack/contracts/shared-contracts.md) is not labeled AGREED.

## 1. Decisions

1. One backend Git repository, npm workspaces and one root lockfile.
2. Two application boundaries: existing root gateway and game-engine.
3. Modules organize capabilities; catalog, sandbox and projection are inside game-engine, not separate services.
4. Only session-scoped player-commands and game-events streams. Message interfaces exist; delivery adapters are deferred.
5. Catalog publishing is a DB write in the engine's catalog schema. Future sandbox jobs share the engine transaction; worker outcomes/exec use engine-local interfaces.
6. Only the envelope `{eventId, sessionId, sessionVersion, occurredAt}`. Distinct events can share a transition version; event identity distinguishes siblings from duplicate delivery. Do not add a seq field.
7. Local kind/runc is a prerequisite check, not an implemented worker. The future single Kubernetes driver selects Kata in production through SANDBOX_RUNTIME_CLASS.
8. The frontend is a separate repository. Browser-safe DTOs are allowed; no frontend implementation/delivery configuration belongs here.

## 2. Module-first layout

```text
package.json                         # Existing gateway + workspace orchestration
package-lock.json                    # Only authoritative backend lock
tsconfig.base.json
tsconfig.json                        # Gateway source/output boundary only
Dockerfile                           # Gateway production image, root context
docker-compose.yml                   # Local applications, stores, setup/migrations
src/
  auth/                              # Existing gateway paths preserved
  users/
  config/
  database/
  health/
  main.ts
  index.js                           # Loads compiled src/runtime/main
apps/
  game-engine/
    package.json
    .env.example
    src/
      app.module.ts
      main.ts
      config/
      health/
      database/migrations/
      modules/
        sessions/
        components/
        projection/
        script-catalog/
        sandbox/                     # Internal job/outcome/exec interfaces only
    test/
  local-runtime/package.json         # Deferred test composition, not deployable
packages/
  contracts/
    src/messages/
    src/views/
    src/server/                      # Provider-independent transport interfaces
    src/index.ts                     # Browser-safe DTO/type exports only
    test/
  messaging/package.json             # Deferred adapter/helpers
infra/local/                         # kind config, runc class, smoke pod
scripts/
  run-foundation.js
  check-local-runtime.sh
projecthon-team5-chart/               # Existing gateway chart, unchanged
presentation/                        # Protected; unchanged
```

Each package has isolated compiler/test configuration. Gateway is not moved to src/modules or apps/gateway; preserving its active paths avoids unnecessary conflicts. Module skeletons contain no fake gameplay or successful sandbox handlers.

## 3. Module responsibilities and data ownership

| Module | Application | Responsibility / data boundary |
|---|---|---|
| auth, users | Gateway | Existing users/token data in gateway DB |
| sessions | Engine | Future session transitions and authoritative state |
| components | Engine | Future puzzle evaluation using module interfaces |
| projection | Engine | Future event-fed views/statistics/SSE in projection schema; no session-table joins |
| script-catalog | Engine | Future scripts/templates/publication in catalog schema |
| sandbox | Engine | Future jobs in engine DB, same transaction as triggering state; Kubernetes worker/outcomes/exec in-process |
| contracts | Shared library | DTOs and transport interfaces only, no persistence |
| messaging | Deferred shared library | Future adapters/outbox/inbox/retries; application-owned persistence |

Task 1.1 creates only engine catalog/projection schemas and migration history. It does not create business tables, sandbox_jobs, outbox/inbox or projection statistics. Future published script/template versions remain immutable and sessions pin a version. There is no catalog outbox or standalone sandbox database.

## 4. Packages and allowed dependencies

| Location | Package | Status |
|---|---|---|
| Root | projecthon-team5 | Existing gateway |
| apps/game-engine | @team5/game-engine | Foundation composition/health |
| packages/contracts | @team5/contracts | Draft DTOs and interfaces |
| packages/messaging | @team5/messaging | Manifest-only, task 1.2 |
| apps/local-runtime | @team5/local-runtime | Manifest-only future test harness |

All packages are private. Internal npm dependencies use matching versions such as `"@team5/contracts": "0.1.0"`, not another manager's workspace protocol. Runtime dependencies are declared by their owning package; compiler/test tooling is shared from root devDependencies.

```text
Browser consumer ----------------> contracts root (types/DTOs)
Gateway / engine ----------------> contracts root and contracts/server
Future messaging ----------------> contracts/server
Future local-runtime ------------> documented application bootstrap seams
```

- Never import another application's private entities, repositories or source paths.
- Engine modules collaborate through explicit in-process seams; composition belongs in app.module.ts.
- Projection remains event-fed; it must not bypass its boundary by reading engine/catalog business tables.
- Libraries do not depend on apps. Do not turn contracts into a shared business/database package.
- The contracts root has no Node/Nest/TypeORM/broker/Kubernetes dependency. `/server` currently defines transport interfaces, not JWT verification, crypto helpers or EntityManager APIs.
- Sandbox interfaces are engine-local, not browser exports.
- No solution fixture or private template is exposed to the client. Views contain only authorized hints/files/results; type safety is not runtime sanitization.

## 5. Local execution

| Component | Host port | Storage |
|---|---|---|
| Gateway (api) | 3000 | postgres: gateway DB, existing pgdata |
| Engine | 3001 | engine-db: engine DB, separate engine_pgdata |
| Gateway PostgreSQL | 5432 | Existing configured DB name preserved |
| Engine PostgreSQL | 5433 | engine_db by default |
| Redis | 6379 | Coordination/cache only |

Containers use service names and container ports; host processes use loopback and published ports. Preserve existing volumes and credentials. Do not run destructive reset commands to fix a migration mismatch.

workspace-init installs the lock into the shared Linux node_modules volume and builds contracts before either app starts. engine-migrate runs the schema-only migration before engine starts. Neither is an independently deployed application. Authenticated npm setup uses a read-only private config path; application containers do not receive that npm secret.

Both apps report their own foundation readiness. Engine requires its DB, schemas and Redis; its response labels module skeletons and unimplemented messaging/worker behavior. Kubernetes readiness is checked separately, using a context-pinned harmless pod. Gateway keeps its existing health response with bounded failure handling.

Two separately running processes are not connected by an in-memory broker. Task 1.2 owns the later local adapter/harness; production Event Hubs and checkpoint storage are also deferred. No cloud messaging credentials are required here.

## 6. Ownership and coordination

| Area | Primary coordination | Integration rule |
|---|---|---|
| Root gateway auth/users | Amit | Preserve current paths/behavior |
| Engine sessions/components | Amit | Keep business logic within module boundaries |
| Engine script-catalog | Amit | Dedicated catalog schema, in-process publication |
| Engine projection | Eden | Own projection schema and event-fed state |
| Engine sandbox | Eden | Same-engine-transaction jobs, internal outcome/exec seams |
| packages/messaging | Eden | Implement against the shared transport interfaces later |
| packages/contracts | Both | Joint contract review before final acceptance |
| Root lock/config/Compose | One integration editor | Serialize dependency and composition changes |

These are coordination conventions, not permission to change public contracts unilaterally. Do not add GitHub handles or ownership automation without confirmation.

## 7. Build, tests and independent delivery

Use Node 22, one root npm ci, and explicit dependency ordering:

```sh
npm ci
npm run build:foundation
npm run test:foundation -- --runInBand
```

Root `build` and `test` remain gateway-only. Each workspace uses its own compiler/Jest config. Required checks are never hidden behind --if-present; deferred shells are intentionally excluded.

Contracts changes require all consumer/type checks, including Node-free browser imports. Gateway image validation must run its actual entrypoint and health route, not merely compile TypeScript. Build from root with the lock and relevant manifests; built workspace exports must exist wherever a runtime import uses them.

The gateway Dockerfile uses Node 22 and BuildKit npm secrets without shipping credentials. Existing gateway Helm and CI entry paths remain intact. Engine production rollout is later work; this foundation's engine runs through Compose, not a new independent deployment pipeline.

## 8. Acceptance and deferred work

See [feature tasks](specs/001-shared-contracts-stack/tasks.md) for actual progress and [quickstart](specs/001-shared-contracts-stack/quickstart.md) for reproducible checks. This document does not modify the protected root task tracker.

Required foundation evidence: ordered builds/type checks, gateway regressions, closed message inventory, browser exports, real Compose health/failure/recovery/persistence checks, real kind/runc smoke completion, gateway image startup, secret-free examples and final joint approval.

Deferred: catalog publishing/tables, gameplay, projection statistics/SSE, messaging adapters/outbox/inbox/retries, local integration harness, durable sandbox jobs/worker/execution/recovery, production Kata provisioning, Event Hubs and frontend delivery.

The user explicitly allowed draft implementation before initial contract approval. This is not a claim that both contributors approved the proposal; final joint review remains required.
