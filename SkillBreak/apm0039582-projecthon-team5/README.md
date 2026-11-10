# Projecthon Team 5

Module-oriented backend with an existing NestJS gateway and game-engine. The gateway provides authentication, profiles, administration and Swagger. The engine includes the room-1 catalog, sessions/state machine, components, injectable messaging, owner-authorized session projection/SSE and opt-in local SQL sandboxes.

## Deploy the backend to AKS

The Dev Helm values deploy the Team 5 gateway and Engine together using the existing
`tdp-wst2-dev-app-aks` context and `tdp-2026` namespace described in [the access guide](tdp-2026-access-guide.md).
The `projecthon-team5` release owns only the Team 5 backend.
The shared `projecthon-fe` release continues to own the frontend and API ingress.

| Browser path on `https://projecthon.dev.att.com` | Target |
| --- | --- |
| `/team5` | Existing shared frontend |
| `/api/team5/*` | Shared frontend ingress → Service `projecthon-team5:80` → gateway :3000 |
| `/api/team5/sessions/:id/stream` | More-specific, unbuffered Team 5 ingress → Service `projecthon-team5:3001` → Engine |

Gateway and Engine run together in **one backend process/pod**, sharing the existing
in-process messaging transport for gameplay commands. The API also makes authenticated
owner/session HTTP calls to Engine at `127.0.0.1:3001`; the browser's SSE connection
reaches Engine through Service port 3001.
No frontend or PostgreSQL resources are created by this release. Persistent
data remains in the shared PostgreSQL `team5` schema.

### One-time prerequisites

- The existing ingress controller, host/DNS, `dev-ingress-tls`, `jfrog-registry`,
  Key Vault CSI integration, and shared API ingress must be available.
- Dev uses the existing Key Vault `tdp-2026` and Secrets Store CSI integration:
  `projecthon-team5-jwt-access-secret` maps to `JWT_ACCESS_SECRET` and
  `projecthon-team5-internal-api-token` maps to `INTERNAL_API_TOKEN`, both in
  `projecthon-team5-runtime` in namespace `tdp-2026`. Keep both mappings together
  so CSI synchronization preserves the JWT key. The DB credential mappings remain
  in `projecthon-team5-secrets`.
- Store approved existing values in Key Vault without logging them. Both must be
  distinct canonical base64 encodings of at least 32 random bytes; do not regenerate
  existing keys during deployment or put values in Helm, images, source, or CI/CD.
  The AKS CSI identity must have permission to read both Key Vault entries.
- The deployment script checks the runtime Secret before Helm upgrades. On first
  provisioning, apply the CSI mappings and allow a backend pod mounting
  `projecthon-team5-spc` to synchronize both keys before invoking the script.
  When adopting an existing manually provisioned runtime Secret, add the label
  `secrets-store.csi.k8s.io/managed=true` without replacing its data; otherwise
  CSI synchronization can time out. CSI-managed Secrets follow the lifetime of
  their consuming pods; Key Vault is the durable source of the credentials.
  Environment-variable changes require a pod restart; Key Vault rotation alone
  does not refresh credentials in a running process.

### Build and deployment

Build/publish the versioned backend image through the approved private registry
pipeline. For a manual backend image build on an authorized workstation, use:

```sh
docker build --platform linux/amd64 --secret id=npmrc,src="$(npm config get userconfig)" \
  -t <backend-image>:<version> .
```

For the standard deployment, run the `projecthon-team5 - CD` workflow from
GitHub Actions with the published version, the configured authentication ID,
and the Dev deployment enabled. The RevUp action uses the same Dev Helm values.
For an authorized workstation, the backend-only deployment helper accepts the
already-published versioned backend image:

```sh
npm run deploy:aks -- --backend-image <private-backend-image>:<version>
```

Add `--dry-run` to lint/render without contacting or modifying AKS. Add
`--values /absolute/path/to/overrides.yaml` for reviewed environment overrides.
The script checks the existing secrets and shared API ingress, deploys the backend
and waits for readiness, and checks the shared frontend and gateway health.
It supports Helm 3 and 4 and uses rollback-on-failure. It does not build or push
images, modify kubeconfig, create a namespace, deploy the frontend, or read a local
`.env` for deployment.

Before the backend starts, its init container runs the idempotent Users/Engine
migrator and, by default, the existing conflict-checking catalog/gameplay seeds.
Use `fullStack.seedCatalog=false` to manage those seeds separately. No existing
tables are dropped/recreated, no local data is copied, and no administrator is
automatically seeded. Failed initialization prevents backend traffic.
Readiness checks both servers, PostgreSQL dependencies and connected,
authenticated projection. Liveness checks the shared process's listener without
restarting it just because PostgreSQL is temporarily unavailable.

### Operating limitations

- Keep one backend replica and `Recreate` strategy. The chart rejects horizontal
  scaling; upgrades briefly interrupt backend service. Accepted in-memory commands
  can be lost on process restart. A distributed durable transport is required
  before multi-pod/HA operation.
- The SQL puzzle runs in-process with the embedded sandbox driver (`SANDBOX_ENABLED=true`,
  default `SANDBOX_DRIVER=embedded`); no sandbox pods are created. For pod sandboxes,
  deploy/certify the existing sandbox RBAC, namespace/network policy, Kata runtime,
  and digest-pinned SQL image before enabling it. The default catalog's legacy SQL
  template cannot execute in this configuration; deploying the UI/API does not make
  that puzzle playable. There is no local-Docker executor fallback in AKS.
- A rollback restores Kubernetes workloads, **not database migrations or seeds**.
  Keep schema changes backward-compatible and never run reset/revert commands
  against the shared database.
- The standard RevUp Dev release and manual helper use the same Dev values. Avoid
  running competing Helm releases against `projecthon-team5`; the shared frontend
  remains independently owned.

## Shared Kubernetes database

The deployed PostgreSQL database is `tdp-2026-db`. Both applications use **only**
the `team5` schema, with certificate-verified TLS and a `team5`-only search path.
Catalog and projection tables are no longer in separate PostgreSQL schemas.
Projection messaging tables have a `projection_` prefix to avoid colliding with
engine messaging tables. Users and Engine keep separate `users_migrations` and
`engine_migrations` ledgers. PostgreSQL 16's built-in `gen_random_uuid()` is used;
TypeORM must not install shared database extensions.

The Dev Helm values obtain `DB_USER` and `DB_PASSWORD` from the existing Key Vault
integration and set the shared host, database and TLS mode. Do not put credentials
in Helm values or source control. Dev references `JWT_ACCESS_SECRET` from
`projecthon-team5-runtime`; provision that Secret with the
existing local JWT key when retaining local/Dev token compatibility. Updating a
Secret alone does not update a running process's environment; restart the backend
after changing it. DB credentials remain managed by Key Vault CSI. The Dev chart
starts gateway and Engine together; other chart environments must explicitly enable
the full-stack backend configuration before they can serve session streams.

The Dev full-stack init container is the migration mechanism for this environment.
Do not enable `migrations.enabled` alongside it; the chart rejects competing
migration mechanisms. Other reviewed, gateway-only chart environments can use
`migrations.enabled=true` to create a one-shot Job using the application image and
DB secrets. Inspect its logs and completion status before disabling the flag on
a later deployment. The Job creates `team5` if necessary, takes a Team 5 advisory
lock and runs Users followed by Engine migrations. It refuses any database name
other than `tdp-2026-db` or unverified TLS. Migrations are not run automatically
by either application on startup.

For an authorized host-side run without Docker, build with `npm run build:foundation`,
provide `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_SSL`
securely in the process environment, then run `npm run migration:shared`. No JWT
settings are needed for migrations. Run only one migration mechanism at
a time; the individual TypeORM CLI commands below do not acquire the Job's lock.
The migration role needs permission to create the schema and its objects.

These are fresh-schema migrations, not a transfer of local data. Existing databases
with the old `public`, `catalog`, or `projection` layout need a separately planned
data migration; do not run the old reset/revert scripts against the shared database.
The Job does not seed an administrator or game catalog. Review and explicitly run
those seeds after deployment if needed.

The Docker Compose, local database, and local sandbox instructions below describe
the legacy development setup, not the shared Kubernetes database procedure. They
require separate local configuration and must not be used to reset the shared DB.

## Prerequisites

- Node.js 22 LTS and npm
- Docker Desktop with Docker Compose v2.24 or newer only for the legacy local setup
- A browser
- Access to the team npm registry when required by your network
- kind v0.33.0 and compatible kubectl for the independent runtime prerequisite (tested with kubectl v1.37.1 and Kubernetes v1.36.4)

## Configure

From the repository root:

```sh
cp .env.example .env
```

Edit `.env` and replace every `REPLACE_...` value. Generate the JWT secret with `openssl rand -base64 32` and use a separate admin password. Keep `.env` private. The gateway and its seed load the root dotenv configuration. Compose requires separate legacy local database values; do not point its reset workflow at the shared database.

`.env.example` contains local-only settings. Deployment settings are documented
separately in [`.env.deployment.example`](.env.deployment.example); it is a
reference, not an input to local startup or deployment. AKS deployment continues
to use Helm values and Key Vault-managed Secrets, so deployment configuration
cannot replace a developer's local `.env`.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `HOST`, `PORT` | Runtime and API bind address |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL` | PostgreSQL connection |
| `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL`, `JWT_ISSUER`, `JWT_AUDIENCE` | Access-token signing and validation |
| `REFRESH_TOKEN_TTL_DAYS` | Login-family expiry |
| `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Explicit first-admin seed only |
| `INTERNAL_API_TOKEN` | Optional for foundation startup; required for protected catalog/owner HTTP, base64 of at least 32 random bytes, separate from JWT secrets |
| `NPM_USER_CONFIG` | Optional absolute path to private registry config, mounted read-only into dependency setup only |

`DB_SSL=true` verifies the PostgreSQL server certificate. The deployed database requires TLS.

## Legacy Local Install And Start

The old Compose setup and opt-in Docker database integration tests target the previous
database layout. They have not been adapted to the shared-schema setup and are not
the deployment or migration procedure.

Open <http://localhost:3000/api/docs>. `GET /health` checks the database. Swagger authorization is not persisted. Demo API calls should be sent through Swagger UI.

Engine health is at <http://localhost:3001/health>. With SQL disabled it reports `scope: foundation` and `sandboxWorker: disabled`, requiring the Team 5 database tables. Enabled SQL reports `scope: engine-with-sql-sandbox`, requires the sandbox tables and actual enforcement preflight, and distinguishes `starting`, `ready` and `unavailable`. Runtime loss returns 503 with a sanitized category; recovery repeats enforcement preflight before readiness. Local runc is explicitly development-only. Messaging is `not_connected` on standalone startup, or `connected` after an injected consumer subscribes. Gateway health retains its original response. Health is not proof that catalog is seeded, an HTTP token is configured, or the whole distributed game is playable.

For host engine development, copy `apps/game-engine/.env.example` to its ignored `.env` if absent, supply the shared `DB_*` values, then run `npm run start:dev --workspace @team5/game-engine`. Engine dotenv loading is tied to its app directory, not the shell's working directory. Remove stale `DATABASE_URL` and `ENGINE_DB_*` overrides: they take precedence over `DB_*`. SQL sandboxes remain opt-in.

## Task 1.3: Room-1 Catalog

Catalog runs inside `apps/game-engine/src/modules/script-catalog/`, on engine port 3001
and its existing DataSource. There is no separate catalog application, database, port or outbox.
Import `ScriptCatalogModule` and inject its exported `CatalogRepository` for future in-process
engine lookups. Private catalog DTOs and solution fixtures remain engine-local; shared browser
contracts are unchanged.

Adapted from commit `72c864a195d8b6bb798c2aab313d795d0d77a876`: the catalog repository,
room-1 data/tests, schema trigger, seed command and HTTP/token/error-handling behavior.
Changes are module/DI integration, `team5.*` SQL qualification, a forward migration after
the foundation migration, and input policies using the baseline's `command`, `answer` and
`credentials` discriminators. The solution values and puzzle ordering are retained.

For host development, configure the engine's ignored `.env` as described above. Run from root:

```sh
npm run build:foundation
npm run migration:shared
npm run seed:room1 --workspace @team5/game-engine
npm run start:dev --workspace @team5/game-engine
```

The shared migration command reads DB settings from the process environment; inspect its
target before running. Seed only after the migration, with the engine's DB settings configured.

Generate a separate internal token using `openssl rand -base64 32` and set `INTERNAL_API_TOKEN`
privately in the engine `.env` for host execution. Do not log it or
send it to the frontend. Catalog
HTTP returns 503 when no token is configured and 401 for missing/incorrect `x-internal-token`.

| Internal GET route | Published result |
| --- | --- |
| `/internal/scripts/by-slug/escape-room/current` | `{scriptId: "escape-room", version: 1}` |
| `/internal/scripts/escape-room/versions/1` | Three ordered room-1 puzzles, one 45-minute clock, non-final empty room-2 |
| `/internal/templates/:key/versions/1` | `idan-db-sql`, `dana-hash`, or `dana-login` private template |

All routes require the token header and return `Cache-Control: no-store`. Unknown or unpublished
versions return 404; invalid versions return 400; unexpected failures return a sanitized 503.
Templates include private solutions and must never be relayed directly into browser views.
The immutable v1 SQL image remains a legacy placeholder. Task 1.5 explicitly publishes a verified digest-pinned v2; legacy unpinned jobs fail visibly instead of silently remapping the template.

Seeding is transactional and repeatable. Conflicting existing content fails without overwriting
published definitions. PostgreSQL triggers also reject changes/deletions of published or retired
content. Retiring a published row is permitted, but does not make it editable or republishable.
Publishing validation and editor/write endpoints are not included in task 1.3.

```sh
npm test --workspace @team5/game-engine -- --runInBand
```

The opt-in catalog database integration suite still targets the old local layout and
must be updated before use; never run destructive integration tests against the shared database.

## Task 1.4: Engine Sessions And Components

Adapted from `72c864a195d8b6bb798c2aab313d795d0d77a876`. Sessions/state-machine logic
now lives in `apps/game-engine/src/modules/sessions/`; evaluators and the bounded worker pool
live in `modules/components/`. Catalog resolution is in-process, pinned to published versions.
Current shared contracts and Eden's messaging/sandbox/projection sources are unchanged.

The forward `1793570402000-EngineSchema` migration adds sessions, session_puzzles, a fully
redacted command_log, engine_sandbox_requests and the tables used by Eden's messaging entities.
State, inbox receipt, log, outbox and sandbox requests commit atomically. Version checks reject
stale writes; RetryingHandler retries up to five attempts and stores sanitized dead letters.
Per-session transaction locks serialize execution. Event IDs are deterministic UUIDs; sibling
events share sessionVersion but remain distinct, with monotonically ordered outbox timestamps.
The relay is serialized across engine instances using a PostgreSQL advisory lock. Catalog and
projection messaging uses separately prefixed tables within the `team5` schema.

`GET /internal/sessions/:id/owner` requires the same server-only `x-internal-token` header as
catalog and returns only `{ownerId}`. It has no-store responses and sanitized errors.

`@team5/game-engine/bootstrap` exports `createEngineApp(options?)`, which initializes without
listening. Options accept config, an initialized caller-owned DataSource, a producer/consumer,
a SandboxExecutor and a clock. Inject the SAME InMemoryTransport into participating apps;
subscription completes before the factory returns. Close the app to drain command delivery,
stop relay timers and workers, and release owned resources. Injected databases remain caller-owned.
Migrations and seed are explicit, never automatically run by the factory. Standalone startup
has no transport or successful fake executor. Pending outbox events remain durable on failure.

```sh
npm run build:foundation
npm run test:foundation -- --runInBand
npm run test:catalog:integration --workspace @team5/game-engine
npm run test:engine:integration --workspace @team5/game-engine
```

The engine integration suite creates disposable PostgreSQL storage and ephemeral ports. It tests
fresh/upgrade migrations, room-1 progression with real hash/credential components and fake SQL,
deduplication, version-conflict retries, concurrent writers, rollback, dead letters, protected
owner lookup, sibling ordering and factory cleanup. No existing database is reset or migrated by it.

| Source responsibility | Task-1.4 adaptation |
| --- | --- |
| core/state and transition | Canonical userId/messageId, nested views, rejection reasons, no seq or sandbox broker events |
| engine repository/service | Module DI, optimistic versions, transactional effects and complete input redaction |
| catalog HTTP client | In-process CatalogResolver over the merged catalog repository |
| components/hash pool | Canonical command/answer/credentials input, string output, parser and worker bounds retained |
| local reliability fallback | Superseded by Eden's RetryingHandler/inbox/outbox helpers |
| engine migration/bootstrap | Forward migration and create-without-listening factory using current composition |
| sandbox HTTP/provision streams | Existing module-local executor/outcome contracts and persisted request intents |
| projection, gateway sessions, full local runtime | Not copied; owned by later tasks |

The task-1.4 integration suite intentionally retains a fake SQL executor. It is not proof of
database read-only enforcement or runtime isolation. Inputs are not logged; infrastructure errors
use safe categories, and authorized SQL/hash output is emitted only after component evaluation.

## Task 1.5: SQL Sandbox

The in-process sandbox module consumes committed lifecycle requests, provisions an owned pod per
session/puzzle/generation, and retains execution results and outcomes in the existing engine DB.
SQL runs outside engine inbox transactions. One command per sandbox is admitted before dispatch;
duplicates replay durable results, busy commands do not consume their identity, and uncertain
execution is cancelled or fenced before another query can start. Destruction requires confirmed
owned-pod absence and remains retryable on infrastructure failure.

SQL is disabled by default (`SANDBOX_ENABLED=false`); an explicitly injected executor still wins
and suppresses the real worker. `SANDBOX_DRIVER` picks where enabled sandboxes run: `embedded`
(default, in-process, see docs/adr/0001-embedded-sandbox-driver.md) or `kubernetes` (pods). The
Kubernetes local runtime must be explicitly selected with `SANDBOX_DRIVER=kubernetes`,
`SANDBOX_KUBE_CONTEXT=kind-skillbreak-local` and its ignored `KUBECONFIG`. Setup never substitutes
the current context or replaces another cluster. Images must use allowlisted manifest digests.

Follow the [SQL quickstart](docs/acceptance/sql-sandbox-quickstart.md) for dedicated setup, build-only npm
credentials when required, actual isolation preflight, and explicit v1 seed/v2 publication. The
build script does not mutate catalog data. Identical v2 publication is idempotent; conflicts fail,
and the v1 seed must not downgrade an already advanced current pointer.

```sh
npm run test:sandbox:db --workspace @team5/game-engine
SANDBOX_KUBE_CONTEXT=kind-skillbreak-local KUBECONFIG="$PWD/.local/kind.kubeconfig" \
  npm run test:sandbox:runtime --workspace @team5/game-engine
```

These opt-in suites use disposable DB containers and exact run-owned pod identities, never
the configured application database. Live tests verify real permissions, network/PID controls,
five-second execution with one-second response allowance, the combined 65,536-byte UTF-8 output
limit, replay/recovery and SQL-to-room-2 progression. Explicit runs fail on missing prerequisites.
No new HTTP/Swagger endpoint, Azure connection or periodic janitor is added. Detected idle/max
expiry requests durable destruction. Local runc is development-only; production Kata deployment,
including the narrowly authorized node-configuration verification needed by preflight, is deferred
and remains fail-closed.
No hints are configured, so RequestHint returns noHint. Deadline guards run on incoming commands
and outcomes; a background expiry janitor, ruin/reset and final escape behavior are later tasks.
Real sandbox/projection/SSE/browser gameplay, engine production rollout and cross-process transport
remain outside task 1.4. Gateway session commands are implemented in task 1.6 below.

## Task 1.6: Gateway Session Commands

Adapted selectively from `72c864a195d8b6bb798c2aab313d795d0d77a876`, using the merged
task-1.4 owner endpoint and canonical task-1.2 transport contracts. Shared contracts, engine,
messaging, sandbox and projection implementations are unchanged.

| Route | Request | Accepted response |
| --- | --- | --- |
| `POST /sessions` | `{scriptSlug, requestId}` | `202 {sessionId}` |
| `POST /sessions/:sid/puzzles/:key/inputs` | `{commandId, input}` | `202 {commandId}` |
| `POST /sessions/:sid/abandon` | No body | `202` |

All routes retain the existing authenticated-user, token-family revocation and role guards.
Input and abandon require the session owner, including for admins. Unknown sessions return 404;
non-owners return 403. Missing/unavailable owner service or publisher returns sanitized 503.
The engine owner endpoint returns only `{ownerId}`, so the gateway does not infer active status
or promise a 409. Gameplay-state eligibility remains an engine decision.

`input` is exactly one of `{kind: 'command', command}`, `{kind: 'answer', answer}`, or
`{kind: 'credentials', username, password}`. Values must be nonempty strings; additional fields
and encoded input over 8192 UTF-8 bytes are rejected. Request bodies retain the 16 KiB limit.
Script slugs and puzzle keys use lowercase letters, digits and hyphens, at most 64 characters.

Client request/command IDs must be UUIDs. Start derives session identity from authenticated user
and requestId; submit derives messageId from sessionId and commandId; abandon derives one stable
messageId per session. UUID case is normalized. Retries must reuse IDs and the same payload;
changed input requires a new commandId. Commands publish to `player-commands` using canonical
`userId`, never a request-supplied actor. No legacy ownerId/occurredAt/commandId payload fields
are restored. HTTP 202 means publication accepted, not gameplay committed; an immediate owner
lookup after Start can still return 404 until the engine processes the command.

Compiled `src/runtime/main` exports `createGatewayApp({config?, database?, producer?})`.
The factory initializes without listening and does not migrate or seed. It closes owned database
pools on shutdown/startup failure; initialized injected pools and publishers remain caller-owned.
Auth, users, health and throttling share that same database/configuration. `src/index.js` remains
the production entry point. Standalone startup has no publisher and returns 503 for commands;
separate gateway/engine processes do not share an in-memory bus. The joint runtime is in [Room 1 Demo](#room-1-demo).

`ENGINE_INTERNAL_URL` is an HTTP(S) origin (host default `http://127.0.0.1:3001`; Compose
`http://engine:3001`). `INTERNAL_API_TOKEN` must match the engine's server-only token and be
canonical base64 of at least 32 bytes. Owner requests use `x-internal-token`, reject redirects,
and time out after two seconds. Empty token disables owner lookups without disabling auth.
`CORS_ORIGINS` is an exact comma-separated origin allowlist, empty by default, without cookies.
`SWAGGER_ENABLED` defaults off in standalone production and on otherwise; local Compose defaults
on, overridable with `false`. Session Swagger includes input variants and path parameters.
HTTP responses are no-store, including auth/validation failures.

```sh
npm run test:gateway:integration -- --detectOpenHandles
```

This builds the foundation and creates one disposable PostgreSQL container with separate gateway
and engine databases, random credentials, tmpfs storage and ephemeral loopback ports. It runs real
migrations, auth/Argon2/JWT/revocation, engine owner HTTP, CORS/Swagger/throttling and lifecycle tests.
The engine owner row is a direct test fixture, and publishers are controlled test doubles: this
does not validate gateway-to-engine command consumption, projection or real sandbox execution.
Only the test-created container is removed; existing databases and private env files are untouched.

Verified on Node 22.23.4: foundation builds/typechecks; 161 foundation tests (6 contracts, 19
messaging, 72 gateway, 64 engine); 16 catalog, 14 engine and 16 gateway PostgreSQL integration
tests. Engine gameplay regressions use a fake SQL executor. ts-jest's existing Node16 warning
remains; independent compiler checks pass. No gateway image rebuild or production rollout was
performed for task 1.6.

## Session Projection and SSE (task 1.7)

The engine serves `GET /sessions/:sid/stream` on port 3001. Run the new forward
migration before starting it. Set engine `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL`,
`JWT_ISSUER` and `JWT_AUDIENCE` to the gateway's matching access-token settings,
and set `CORS_ORIGINS` to exact browser origins (for example
`http://localhost:5173`). Compose shares these settings, not the gateway database.
Omitting all JWT settings keeps non-streaming startup working; SSE fails closed.

Use bearer-header **fetch streaming**, not native EventSource, which cannot set
Authorization. Never put tokens in URLs. A connection receives a full SessionView
first and then full replacements as `event: session`. SSE IDs are domain versions;
distinct updates can share an ID and **must still be applied**. Rapid updates may
coalesce. Reconnect always returns current state, even with an equal or future
valid Last-Event-ID; there is no historical replay or gameplay reconnect action.

The immutable projected owner must match the token subject. Streams close at
token expiry, so refresh through the gateway and reconnect with a valid token.
Unlike gateway-protected APIs, this endpoint does not query logout, suspension
or token-family revocation until expiry (default maximum remaining exposure:
15 minutes).

Errors before streaming: 400 malformed session/cursor; 401 missing/invalid/expired
bearer; 403 wrong owner/origin; 503 `projection_not_ready` with `Retry-After: 1`
for absent state, or `projection_unavailable` for unavailable dependencies/auth.
Listener or read failures after headers close the connection. Heartbeats are
comments every 15 seconds. Disable proxy buffering/compression for this route,
route it to engine rather than gateway, and allow idle periods over 15 seconds.
Slow clients retain only the latest pending snapshot and close after 15 seconds
without drain.

Health now reports `modules.projection: implemented` and separate
`projection.tables`, `listener`, `consumer`, `auth` and `live` fields.
Store/listener failures degrade readiness. Missing auth or transport remains
explicitly non-live; foundation readiness is not proof of playable gameplay.

```sh
npm run build --workspace @team5/game-engine
npm run typecheck --workspace @team5/game-engine
npm run test:projection:integration --workspace @team5/game-engine -- --detectOpenHandles
```

The disposable PostgreSQL/fake-executor harness exercises two actual HTTP readers,
restart/recovery, authorization and 100 end-to-end timing samples. See the
[acceptance guide](docs/acceptance/session-projection-sse-quickstart.md) for all focused
commands and the [stream contract](docs/acceptance/session-stream-contract.md)
for framing.

Supported events: SessionStarted, PuzzleOpened, CommandEvaluated, PuzzleSolved,
RoomEntered and SessionAbandoned. Expiry/escape/hints/reset events are explicitly
receipted no-ops; terminal parity for those events is not implemented. Separate
Compose gateway/engine processes have **no connected production transport**.
The injected in-memory adapter is volatile, same-process only, and cannot restore
events lost before subscription or during process downtime. This is not a
production delivery/SLA guarantee or a real sandbox execution test.

## Local Kubernetes Prerequisite

This verifies a harmless runc pod, not a sandbox worker. Local runc isolation is weaker than production Kata. Use only the dedicated local context:

```sh
mkdir -p .local
kind create cluster --name skillbreak-local --config infra/local/kind.yaml --kubeconfig .local/kind.kubeconfig
kubectl --kubeconfig .local/kind.kubeconfig --context kind-skillbreak-local apply -f infra/local/runtimeclass-runc.yaml
KUBECONFIG="$PWD/.local/kind.kubeconfig" SANDBOX_RUNTIME_CLASS=runc sh scripts/check-local-runtime.sh
```

Inspect/reuse an existing named cluster instead of replacing it. The helper is context-pinned, bounded, refuses existing smoke pods, and deletes only its own generated pod. Missing classes/contexts, runtime failures and cleanup failures return nonzero.

If a corporate CA is trusted by Docker Desktop but not by kind nodes, preload the image through Docker rather than disabling TLS verification:

```sh
docker pull busybox:1.37.0
kind load docker-image busybox:1.37.0 --name skillbreak-local
```

If Docker's multi-platform image store causes `content digest ... not found`, export only the node platform and load the archive (use `linux/amd64` on x86 hosts):

```sh
docker image save --platform linux/arm64 busybox:1.37.0 -o .local/runtime-smoke.tar
kind load image-archive .local/runtime-smoke.tar --name skillbreak-local
```

Re-run the helper afterward. Production must provision a real Kata handler/RuntimeClass and configure `SANDBOX_RUNTIME_CLASS`; a local runc success does not prove Kata isolation. There is no separate Docker sandbox driver.

## Authentication And Admin APIs

| Route | Access | Behavior |
| --- | --- | --- |
| `POST /auth/signup`, `POST /auth/login` | Public | Create player account; login issues access and refresh credentials |
| `POST /auth/refresh` | Refresh credential | Rotate token in the same seven-day family; replay revokes that family |
| `POST /auth/logout` | Refresh credential | Revoke one login family; idempotent |
| `POST /auth/logout-all` | Player/admin | Revoke all families and invalidate the access-token version |
| `GET /me`, `PATCH /me` | Player/admin | Read/update display name |
| `PATCH /me/password` | Player/admin | Verify current password, change hash, and require a fresh login |
| `/admin/users` | Admin | Create, list, inspect, change role, disable/enable, and soft-delete users |

Admin membership changes are serialized in PostgreSQL; self-mutation and removal of the last active admin are rejected. For gateway-protected APIs, disabled, deleted, role-changed, password-changed, and logged-out credentials are invalidated immediately on the next protected request. Engine SSE uses the expiry-only boundary described above. Deleted usernames and emails remain reserved.

## Room 1 Demo

`apps/local-runtime` starts the gateway (port 3000) and the engine (port 3001) in one process, joined by one
`InMemoryTransport`. It replaces the Compose `api` and `engine` containers for the demo. Every Nest log line and
one `GameEvents` line per game event (type, sessionId and messageId, never the payload) go to `room1-trail.log`.

Before you start:
- `.env` is configured (see Configure), including `INTERNAL_API_TOKEN`. For the browser, set `CORS_ORIGINS` to the
  frontend origin, for example `http://localhost:5173`.
- `npm ci` has run at the root.

Pick the SQL sandbox (embedded is the default; there is no automatic fallback):

| Mode | Command | Needs |
| --- | --- | --- |
| embedded (default) | `sh scripts/demo-room1.sh` | Nothing extra. SQL runs in-process on the same `room1-sql-v1` fixture (embedded driver); no container, kind cluster or pod. Publishes SQL template 2 pinned to the embedded fixture (`seed:room1:sql --embedded`), then gameplay catalog 4 and the Room 2 content as script v5 (`seed:room2`; regenerate it with `npm run room2:generate`, check it with `npm run room2:verify`). Use a separate development database from kind mode. |
| kind | `sh scripts/demo-room1.sh kind` | The kind cluster from [Local Kubernetes Prerequisite](#local-kubernetes-prerequisite), `SANDBOX_KUBE_CONTEXT=kind-skillbreak-local`, `KUBECONFIG` and `SANDBOX_IMAGE_ALLOWLIST` exported. Builds the image if `.local/sql-sandbox-image-ref` is missing, publishes SQL template 2, then publishes gameplay catalog 4. For an authenticated build registry, pass `SANDBOX_BUILD_NPMRC` as a BuildKit secret path. |
| local container (development only) | `sh scripts/demo-room1.sh local` | The `local/room1-sql:dev` image, built once with `docker compose --profile demo-local build sql-sandbox` (needs `NPM_USER_CONFIG`). Explicitly selects shared-container SQL and publishes gameplay catalog 3 when SQL template 2 is absent. A catalog already advanced to Kubernetes gameplay is never downgraded. Use a separate development database for this mode. |

The script stops `api` and `engine`, starts `postgres` and `engine-db`, runs both migrations and the room-1
seed, builds the foundation and `apps/local-runtime`, and starts the runtime in the foreground. Stop it with Ctrl-C.

Play Room 1:
1. Sign up and log in. The browser uses `/auth/browser/login`, `/refresh` and `/logout` under `/auth/browser`; the existing body-token APIs remain available to non-browser clients.
2. Resume with `GET /sessions/resume`, or explicitly start with `POST /sessions` and a stable `requestId`. Concurrent starts for the same user return one active game.
3. Open SQL, Hash Cracker, or Dana's computer independently. The normal clue path remains SQL join -> hash -> Dana credentials; correctly guessed credentials also work.
4. Successful Dana login unlocks her desktop and records the SQL milestone. The door stays closed and Room 1 remains current.
5. Click the desktop file to open the door (`POST /sessions/:id/rooms/room-1/open-door`). This still leaves Room 1 current.
6. Click the physical open door (`POST /sessions/:id/rooms/room-1/enter`) to enter Room 2. Git/TLS remain future work.

The single server-owned 45-minute deadline continues across rooms, refresh, sign-out and disconnection.
Device drafts are scoped to the browser, user and game; account credentials and tokens are not stored there.
Sign-out does not abandon the game. Leave game does. Expiry shows Game Over with an explicit return action.

Browser refresh uses an HttpOnly, SameSite=Strict cookie and `X-Skillbreak-Browser: 1` on auth requests.
Production requires HTTPS and same-site frontend/API deployment (prefer a same-origin API proxy); explicitly
allow credentialed CORS origins when using separate origins. Arbitrary cross-site embedding is not supported.
Modern browsers must support Web Locks for serialized cross-tab refresh and BroadcastChannel for account
switch/logout notifications. Legacy browsers without these APIs have not been certified for multi-tab auth.

New games pin immutable catalog 3 (development SQL) or 4 (Kubernetes SQL). Catalog 1/2 games keep their
historical locks/automatic entry; reseeding never rewrites them. Start/resume expires overdue games, keeps
the oldest live game, and abandons legacy duplicate active games without deleting their history.

Kubernetes SQL remains owned by its session/puzzle/generation/UID until a terminal game event, including
after SQL completion and Room 2 entry. New gameplay ignores the old 15-minute idle cutoff. Offline expiry
runs at startup and every second; deletion is durably retried and confirms owned absence. A failed query
against a lost pod fences its generation; after confirmed destruction, active gameplay provisions the next
generation without resetting progress or the deadline. This is query-triggered recovery, not a continuous
pod-liveness scanner. Terminal games never reprovision.

See [Gameplay Fixes and Test Plan](GAMEPLAY-FIXES-AND-TESTS.md#validation-commands-and-evidence) for executed
tests and remaining gates. The real six-second watchdog test is currently failing; full end-to-end
certification is not complete.

Check the trail:

```sh
grep RoomEntered room1-trail.log
grep -o 'sessionId=[0-9a-f-]*' room1-trail.log | sort | uniq -c
grep -c -E 'danaZ22|ea7e95b6|Bearer' room1-trail.log
```

The first includes initial room entry and accepted physical-door entry; the second shows session IDs.
With default redacted logging, the third must print `0`. Normal logs omit payloads, SQL, result rows,
answers and tokens. Interactive terminals use Nest colors; explicit `NO_COLOR` and non-interactive
collectors remain uncolored.

For the configured local setup, run `sh start-local.sh` from this repository. This launcher uses the
existing local Kubernetes configuration and retained Compose api/engine database settings, and enables
`GAMEPLAY_DEBUG_LOGS=true` by default. Local debug logs show submitted SQL, submitted hashes with
correct/incorrect outcomes, and Dana puzzle usernames/passwords with their verdicts. SQL dispatch and
completion identify the namespace, pod, UID, generation, session and command. Execution outcomes
(`success`, `failed`, `timeout`, `unknown`) are distinct from the SQL puzzle's solved/progress verdict.
A rejected SQL attempt may never reach a pod; it has a puzzle verdict but no dispatch/completion entry.

These values appear in the terminal **and `room1-trail.log`**. Do not enter real passwords into puzzles
or share debug logs. Debug input logging is disabled in production; account authentication credentials,
tokens, query result rows and database secrets are not added to logs. The database `command_log` stays
redacted. To disable local debug input logging, run `GAMEPLAY_DEBUG_LOGS=false sh start-local.sh`.

## Demo Flow

1. Run `GET /health` in Swagger UI.
2. Create a player with `POST /auth/signup`, then sign in with `POST /auth/login`.
3. Use the returned access token with `GET /me`, `PATCH /me`, and `PATCH /me/password`.
4. Rotate a refresh credential using `POST /auth/refresh`; demonstrate single-family logout and logout-all.
5. Sign in as the seeded admin to create/list users, change roles, disable/enable users, and soft-delete a test account. Show a player receives `403` for admin routes.
6. Read `/me` again, restart only the API with `docker compose restart api`, then sign in and read the same persisted user again.
7. Show the `User` entity, the migration, and the controller-to-service-to-TypeORM path. The first planned Demo 2 feature is an authenticated `POST /sessions` that starts a server-timed escape-room session.

Avoid putting access or refresh credentials in URLs, logs, or persistent browser storage.

## Stop And Reset

Stop containers without deleting data:

```sh
docker compose down
```

To intentionally destroy this Compose project's local volumes, including both gateway and engine data and its container dependency cache, run this single guarded command from the repository root:

```sh
npm run db:reset -- --confirm-local-reset
```

The reset validates the Compose project and service images before removing volumes, then reinstalls dependencies, starts PostgreSQL, runs migrations, and seeds the admin. Do not run it when you need the local database contents. Editing PostgreSQL credentials in `.env` does not alter credentials already stored in an existing volume.

## Development And Tests

```sh
npm run build
npm test
npm run build:foundation
npm run test:foundation -- --runInBand
```

Run `npm ci` at the root before host builds, then `npm run build:foundation` to build workspace dependencies. Node 22 is the supported validation baseline (tested host Node 22.23.4 / npm 11.20.0; Compose Node 22.23.4 / npm 10.9.9). Root build/tests remain gateway-only; the foundation commands build contracts first, type-check package consumers and run each package's isolated tests. Database suites are opt-in and run separately. No required package is silently skipped.

`npm run start:dev` starts gateway watch mode. Production `npm start` still uses `src/index.js` and compiled `src/runtime`. The Dockerfile now uses Node 22, the workspace lock/manifests and ephemeral npm authentication secrets. Existing Helm/CI deployment paths remain unchanged.

```sh
docker build --secret id=npmrc,src="$(npm config get userconfig)" -t skillbreak-gateway .
```

Omit `--secret` if the configured registry needs no authentication. No user npm config or local env file is copied into the image.

The root package is gateway; `apps/game-engine` composes sessions, components, projection, script-catalog and sandbox modules. `packages/contracts` exports browser-safe DTOs at its root and transport interfaces at `/server`. Sandbox interfaces stay engine-local. `packages/messaging` implements the in-memory transport and persistence helpers; `apps/local-runtime` runs both apps in one process for the [Room 1 Demo](#room-1-demo). All packages are private, with one root lock. Frontend implementation remains in its separate repository.

See [DESIGN-v2.md](DESIGN-v2.md) for the authoritative target architecture and the implementation gaps. Contract payloads remain a draft pending joint contributor approval.

## Current Scope

Implemented: existing gateway features, owner-protected gateway session commands with injectable publication, draft shared contracts, two-app foundation, catalog and engine persistence, room-1 transitions/components, protected catalog/owner routes, owner-authorized session projection/SSE, injectable in-memory messaging and transactional reliability, truthful health and local kind prerequisite validation. Not implemented: full playable runtime, publish-time validation/editor endpoints, real sandbox worker/execution/recovery, production transport or Kata provisioning. Authentication rate limits use one gateway process with an in-memory store; this is local development, not public multi-replica deployment.